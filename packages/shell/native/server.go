package native

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"runtime"
	"strings"
	"sync"
	"time"
)

// defaultTimeout 是非交互命令的默认 RPC 上限。交互命令（path.choose*）
// 由用户操作决定时长，不设超时。
const defaultTimeout = 5 * time.Second

// Config 构造原生服务 handler 所需的全部依赖。
type Config struct {
	// Token 是 /invoke 的 Bearer 凭据。Start 总是生成新的随机 token；
	// NewHandler 的测试/嵌入使用方可以直接注入。
	Token string
	// Registry 是命令注册表；nil 等价于空表。
	Registry *Registry
	// HasWindow 表示外壳是否有窗口；--url 降级模式为 false。
	HasWindow bool
	// Platform / Arch 默认取 runtime.GOOS / runtime.GOARCH，测试可覆盖。
	Platform string
	Arch     string
	// Timeout 是非交互命令的 RPC 上限，零值使用 defaultTimeout。
	Timeout time.Duration
}

func (c Config) withDefaults() Config {
	if c.Registry == nil {
		c.Registry = NewRegistry()
	}
	if c.Platform == "" {
		c.Platform = runtime.GOOS
	}
	if c.Arch == "" {
		c.Arch = runtime.GOARCH
	}
	if c.Timeout <= 0 {
		c.Timeout = defaultTimeout
	}
	return c
}

// infoResponse 是 GET /info 的响应，字段名与 protocol 的 NativeInfo 一致。
type infoResponse struct {
	ContractVersion int      `json:"contractVersion"`
	Platform        string   `json:"platform"`
	Arch            string   `json:"arch"`
	HasWindow       bool     `json:"hasWindow"`
	Commands        []string `json:"commands"`
}

// invokeRequest 是 POST /invoke 的请求体。input 保持原始 JSON，由命令自行解码。
type invokeRequest struct {
	Command string          `json:"command"`
	Input   json.RawMessage `json:"input"`
}

// successResponse / failureResponse 是统一 envelope 的两半。
type successResponse struct {
	OK    bool `json:"ok"`
	Value any  `json:"value"`
}

type failureResponse struct {
	OK       bool   `json:"ok"`
	Code     string `json:"code"`
	Message  string `json:"message,omitempty"`
	Platform string `json:"platform,omitempty"`
}

// maxRequestBytes 限制请求体大小，避免本机进程用超大 JSON 拖垮外壳。
const maxRequestBytes = 1 << 20

// NewHandler 构造原生服务的 HTTP handler。
//
// /info 不鉴权：它只暴露契约版本与已注册命令，不含任何凭据；/invoke 必须带
// Bearer token。
func NewHandler(cfg Config) http.Handler {
	cfg = cfg.withDefaults()

	mux := http.NewServeMux()
	mux.HandleFunc("/info", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		writeJSON(w, http.StatusOK, infoResponse{
			ContractVersion: ContractVersion,
			Platform:        cfg.Platform,
			Arch:            cfg.Arch,
			HasWindow:       cfg.HasWindow,
			Commands:        cfg.Registry.Commands(),
		})
	})
	mux.HandleFunc("/invoke", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !authorized(r.Header.Get("Authorization"), cfg.Token) {
			w.Header().Set("WWW-Authenticate", "Bearer")
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		var req invokeRequest
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxRequestBytes))
		if err := decoder.Decode(&req); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}

		value, nativeErr := dispatch(cfg, r.Context(), req)
		if nativeErr != nil {
			writeJSON(w, http.StatusOK, failureResponse{
				OK:       false,
				Code:     nativeErr.Code,
				Message:  nativeErr.Message,
				Platform: nativeErr.Platform,
			})
			return
		}
		writeJSON(w, http.StatusOK, successResponse{OK: true, Value: value})
	})

	return mux
}

// authorized 校验 Bearer 凭据，比较必须是常量时间。
func authorized(header, token string) bool {
	const prefix = "Bearer "
	if token == "" || !strings.HasPrefix(header, prefix) {
		return false
	}
	got := strings.TrimPrefix(header, prefix)
	return subtle.ConstantTimeCompare([]byte(got), []byte(token)) == 1
}

// dispatch 查找命令并执行。未知命令属于业务错误 invalid，不是 HTTP 404：
// 调用方只需要解析 envelope。
//
// 并发约束在这里统一实施：path.choose* 同一时刻只允许一个（第二个 busy）；
// window.* 串行执行。交互类命令不设 RPC 超时，其余命令使用 cfg.Timeout。
func dispatch(cfg Config, ctx context.Context, req invokeRequest) (any, *Error) {
	handler, ok := cfg.Registry.lookup(req.Command)
	if !ok {
		if isContractCommand(req.Command) {
			return nil, &Error{
				Code:     CodeUnsupported,
				Message:  "当前平台未实现命令: " + req.Command,
				Platform: cfg.Platform,
			}
		}
		return nil, &Error{Code: CodeInvalid, Message: "未知命令: " + req.Command}
	}

	if isInteractive(req.Command) {
		if !tryAcquire(cfg.Registry.chooseGate) {
			return nil, &Error{Code: CodeBusy, Message: "已有路径选择正在等待用户操作"}
		}
		defer releaseGate(cfg.Registry.chooseGate)
		value, err := callHandler(ctx, handler, req.Input)
		return mapHandlerResult(ctx, value, err)
	}

	callCtx, cancel := context.WithTimeout(ctx, cfg.Timeout)
	defer cancel()

	if isWindow(req.Command) {
		select {
		case cfg.Registry.windowGate <- struct{}{}:
		case <-callCtx.Done():
			return nil, &Error{Code: CodeTimeout, Message: "等待窗口命令完成超时"}
		}
		return runWithTimeout(callCtx, handler, req.Input, func() {
			releaseGate(cfg.Registry.windowGate)
		})
	}
	return runWithTimeout(callCtx, handler, req.Input, nil)
}

type handlerResult struct {
	value any
	err   error
}

// runWithTimeout 在独立 goroutine 中执行 handler，超时后立即返回 timeout。
// release 由 goroutine 在 handler 真正结束时调用，确保窗口命令的串行约束不会
// 因为调用方超时而被提前解除。
func runWithTimeout(ctx context.Context, handler Handler, input json.RawMessage, release func()) (any, *Error) {
	result := make(chan handlerResult, 1)
	go func() {
		if release != nil {
			defer release()
		}
		value, err := callHandler(ctx, handler, input)
		result <- handlerResult{value: value, err: err}
	}()

	select {
	case res := <-result:
		return mapHandlerResult(ctx, res.value, res.err)
	case <-ctx.Done():
		// handler 可能恰好在超时边界完成：优先采用已经产生的结果。
		select {
		case res := <-result:
			return mapHandlerResult(ctx, res.value, res.err)
		default:
			return nil, &Error{Code: CodeTimeout, Message: "原生命令执行超时"}
		}
	}
}

// callHandler 把 handler 的 panic 转成错误，避免一个命令实现拖垮整个外壳。
func callHandler(ctx context.Context, handler Handler, input json.RawMessage) (value any, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("原生命令 panic: %v", recovered)
		}
	}()
	return handler(ctx, input)
}

func mapHandlerResult(ctx context.Context, value any, err error) (any, *Error) {
	if err == nil {
		return value, nil
	}
	var nativeErr *Error
	if errors.As(err, &nativeErr) && nativeErr != nil {
		return nil, nativeErr
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return nil, &Error{Code: CodeTimeout, Message: "原生命令执行超时"}
	}
	return nil, &Error{Code: CodeInternal, Message: err.Error()}
}

func isInteractive(command string) bool {
	return strings.HasPrefix(command, "path.choose")
}

func isWindow(command string) bool {
	return strings.HasPrefix(command, "window.")
}

// tryAcquire 是非阻塞获取：拿不到就是 busy，不排队。
func tryAcquire(gate chan struct{}) bool {
	select {
	case gate <- struct{}{}:
		return true
	default:
		return false
	}
}

func releaseGate(gate chan struct{}) {
	<-gate
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

// Server 是正在运行的回环原生服务。
type Server struct {
	httpServer *http.Server
	url        string
	token      string

	closeOnce sync.Once
	closeErr  error
}

// Start 在 127.0.0.1 的随机端口上监听并生成 32 字节随机 token。
//
// 只绑定回环地址，因此不接受外部连接；调用方应在启动 supervisor 之前调用它，
// 成功后再把 URL 与 token 注入 supervisor 环境。Close 可重复调用。
func Start(cfg Config) (*Server, error) {
	cfg = cfg.withDefaults()

	token, err := generateToken()
	if err != nil {
		return nil, err
	}
	cfg.Token = token

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("监听原生服务失败: %w", err)
	}

	server := &Server{
		httpServer: &http.Server{Handler: NewHandler(cfg)},
		url:        "http://" + listener.Addr().String(),
		token:      token,
	}
	go func() {
		// Serve 在 Close 后会返回 ErrServerClosed，这是正常关闭路径。
		_ = server.httpServer.Serve(listener)
	}()
	return server, nil
}

// URL 是 worker 访问原生服务的基础地址，不含尾部斜杠。
func (s *Server) URL() string { return s.url }

// Token 是 /invoke 的 Bearer 凭据。外壳退出前只在 supervisor 环境里传递。
func (s *Server) Token() string { return s.token }

// Close 关闭监听与在途连接，可重复调用。
func (s *Server) Close() error {
	s.closeOnce.Do(func() {
		s.closeErr = s.httpServer.Close()
	})
	return s.closeErr
}

func generateToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("生成原生 token 失败: %w", err)
	}
	return hex.EncodeToString(buf), nil
}
