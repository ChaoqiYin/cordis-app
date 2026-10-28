/**
 * 由 schemastery 结构自动生成表单。
 *
 * 不引入表单库：需要覆盖的类型有限（string / number / boolean / union / array /
 * object），而表单库会要求把 schema 翻译成它自己的形状，等于维护两套描述。
 * 直接读 schema 的 `type` 与 `meta` 反而是最短路径——这也正是选 schemastery
 * 的理由（架构文档 8.1）。
 *
 * 两段式提交：控件改的是本地草稿，点「保存」才写回。原因是配置变更会触发
 * 插件 restart（架构文档 8.3），逐字符保存等于逐字符重启。
 */

import { useMemo, useState, type ReactNode } from 'react'

/** schemastery 的结构子集。只声明我们真正读的字段。 */
export interface SchemaNode {
  type?: string
  meta?: {
    default?: unknown
    description?: string
    role?: string
    min?: number
    max?: number
    step?: number
    required?: boolean
    hidden?: boolean
    disabled?: boolean
  }
  /** object */
  dict?: Record<string, SchemaNode>
  /** array */
  inner?: SchemaNode
  /** union / const */
  list?: SchemaNode[]
  value?: unknown
}

type Value = unknown

export function SchemaForm(props: {
  schema: SchemaNode
  value: Record<string, unknown>
  disabled?: boolean
  onSave(value: Record<string, unknown>): void
}): ReactNode {
  const initial = useMemo(
    () => ({ ...defaultsOf(props.schema), ...props.value }),
    // 配置从服务端加载完成后才成为 value 的稳定来源；只在它换对象时重置草稿
    [props.schema, props.value],
  )
  const [draft, setDraft] = useState<Record<string, unknown>>(initial)
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(initial), [draft, initial])

  const fields = Object.entries(props.schema.dict ?? {}).filter(
    ([, node]) => !node.meta?.hidden,
  )

  return (
    <div className="schema-form">
      {fields.map(([key, node]) => (
        <Field
          key={key}
          name={key}
          node={node}
          value={draft[key]}
          disabled={props.disabled || node.meta?.disabled}
          onChange={(next) => setDraft((prev) => ({ ...prev, [key]: next }))}
        />
      ))}

      <div className="schema-actions">
        <button
          type="button"
          className="button"
          disabled={!dirty || props.disabled}
          onClick={() => props.onSave(draft)}
        >
          保存
        </button>
        <button
          type="button"
          className="button button-ghost"
          disabled={!dirty || props.disabled}
          onClick={() => setDraft(initial)}
        >
          撤销
        </button>
        {dirty && <span className="schema-dirty">有未保存的修改</span>}
      </div>
    </div>
  )
}

/** schema 的默认值：优先 meta.default，其次按类型给一个安全的空值。 */
function defaultsOf(schema: SchemaNode): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, node] of Object.entries(schema.dict ?? {})) {
    if (node.meta?.default !== undefined) result[key] = node.meta.default
    else if (node.type === 'object') result[key] = defaultsOf(node)
    else if (node.type === 'array') result[key] = []
    else if (node.type === 'boolean') result[key] = false
  }
  return result
}

function Field(props: {
  name: string
  node: SchemaNode
  value: Value
  disabled?: boolean
  onChange(value: Value): void
}): ReactNode {
  const { node } = props
  const label = (
    <label className="field-label" htmlFor={`field-${props.name}`}>
      {props.name}
      {node.meta?.required && <span className="field-required">*</span>}
    </label>
  )
  const hint = node.meta?.description ? <p className="field-hint">{node.meta.description}</p> : null

  const control = renderControl(props)
  return (
    <div className="field">
      {label}
      {control}
      {hint}
    </div>
  )
}

function renderControl(props: {
  name: string
  node: SchemaNode
  value: Value
  disabled?: boolean
  onChange(value: Value): void
}): ReactNode {
  const { node, disabled } = props
  const id = `field-${props.name}`

  switch (node.type) {
    case 'boolean':
      return (
        <input
          id={id}
          type="checkbox"
          className="field-checkbox"
          checked={Boolean(props.value)}
          disabled={disabled}
          onChange={(event) => props.onChange(event.target.checked)}
        />
      )

    case 'number':
      return (
        <input
          id={id}
          type="number"
          className="field-input"
          value={typeof props.value === 'number' ? props.value : ''}
          min={node.meta?.min}
          max={node.meta?.max}
          step={node.meta?.step}
          disabled={disabled}
          onChange={(event) =>
            props.onChange(event.target.value === '' ? undefined : Number(event.target.value))
          }
        />
      )

    case 'union': {
      const options = (node.list ?? []).filter((item) => item.type === 'const')
      return (
        <select
          id={id}
          className="field-input"
          value={String(props.value ?? options[0]?.value ?? '')}
          disabled={disabled}
          onChange={(event) => {
            const matched = options.find((item) => String(item.value) === event.target.value)
            props.onChange(matched ? matched.value : event.target.value)
          }}
        >
          {options.map((item) => (
            <option key={String(item.value)} value={String(item.value)}>
              {String(item.value)}
            </option>
          ))}
        </select>
      )
    }

    case 'array':
      return (
        <ArrayField
          id={id}
          node={node}
          value={Array.isArray(props.value) ? props.value : []}
          disabled={disabled}
          onChange={props.onChange}
        />
      )

    case 'object':
      return (
        <div className="field-nested">
          {Object.entries(node.dict ?? {})
            .filter(([, child]) => !child.meta?.hidden)
            .map(([key, child]) => (
              <Field
                key={key}
                name={`${props.name}.${key}`}
                node={child}
                value={(props.value as Record<string, unknown> | undefined)?.[key]}
                disabled={disabled || child.meta?.disabled}
                onChange={(next) =>
                  props.onChange({
                    ...((props.value as Record<string, unknown>) ?? {}),
                    [key]: next,
                  })
                }
              />
            ))}
        </div>
      )

    default:
      // string 与未知类型都退化为文本框；role 决定更具体的控件
      return node.meta?.role === 'color' ? (
        <input
          id={id}
          type="color"
          className="field-input field-color"
          value={typeof props.value === 'string' ? props.value : '#000000'}
          disabled={disabled}
          onChange={(event) => props.onChange(event.target.value)}
        />
      ) : (
        <input
          id={id}
          type="text"
          className="field-input"
          value={typeof props.value === 'string' ? props.value : ''}
          placeholder={node.meta?.role === 'path' ? '路径' : undefined}
          disabled={disabled}
          onChange={(event) => props.onChange(event.target.value)}
        />
      )
  }
}

/** 数组以「每行一项」呈现；元素是对象时退化为 JSON 文本，避免递归出复杂的表格。 */
function ArrayField(props: {
  id: string
  node: SchemaNode
  value: unknown[]
  disabled?: boolean
  onChange(value: Value): void
}): ReactNode {
  const itemType = props.node.inner?.type ?? 'string'
  const simple = itemType === 'string' || itemType === 'number' || itemType === 'boolean'

  const update = (index: number, next: unknown) => {
    const copy = [...props.value]
    copy[index] = next
    props.onChange(copy)
  }

  return (
    <div className="field-array">
      {props.value.map((item, index) => (
        <div className="field-array-row" key={index}>
          <input
            type="text"
            className="field-input"
            value={simple ? String(item ?? '') : JSON.stringify(item)}
            disabled={props.disabled}
            onChange={(event) => {
              const raw = event.target.value
              if (!simple) {
                try {
                  update(index, JSON.parse(raw))
                } catch {
                  // 半截 JSON 不写回，等用户输入完整再解析
                }
                return
              }
              update(index, itemType === 'number' ? Number(raw) : itemType === 'boolean' ? raw === 'true' : raw)
            }}
          />
          <button
            type="button"
            className="button button-ghost"
            disabled={props.disabled}
            onClick={() => props.onChange(props.value.filter((_, i) => i !== index))}
          >
            移除
          </button>
        </div>
      ))}
      <button
        type="button"
        className="button button-ghost"
        disabled={props.disabled}
        onClick={() => props.onChange([...props.value, defaultForType(itemType)])}
      >
        添加
      </button>
    </div>
  )
}

function defaultForType(type: string): unknown {
  if (type === 'number') return 0
  if (type === 'boolean') return false
  if (type === 'object') return {}
  return ''
}
