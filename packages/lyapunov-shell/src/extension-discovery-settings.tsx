import {useEffect, useId, useRef, useState} from 'react'
import {Button, IconChevronRightOutlineRegular, IconCordisPluginOutlineRegular, IconFolderOpenOutlineRegular, IconPluginPinwheelOutlineRegular, IconPlusOutlineRegular, IconSearchOutlineRegular, Input, SegmentedControl} from '@deepseek-ai/dsh-client-ui-primitives'
import {ROCKETBOX_SOURCE} from '../../human-crowd/src/rocketbox-sample.ts'
import {EXTERNAL_TOOL_OPTIONS} from './external-tools.ts'
import type {DiscoveredExtension, DiscoverySource} from './extension-discovery.ts'
import type {ExternalSkillRow} from './plugin-marketplace.ts'
import {SettingsDetails, SettingsField} from './settings-ui.tsx'
import {WorkbenchIcon} from './vendor/tabler/icons.tsx'

type Translate = (zh: string, en: string) => string
type MarketKind = DiscoveredExtension['kind'] | 'skill'
type MarketCategory = Exclude<MarketKind, 'tool'>
const marketCategories = ['mcp', 'skill', 'software', 'model', 'bundle', 'asset'] as const satisfies readonly MarketCategory[]
const pageSize = 30
const overviewPageSize = 6
export interface MarketSourceReference {name: string; url: string; version?: string; stale?: boolean}
type MarketRow = Omit<DiscoveredExtension, 'catalogId' | 'kind'> & {
  kind: MarketKind
  optionsId?: string
  skillId?: string
  sources: MarketSourceReference[]
}
type MarketSource = DiscoverySource & {stale?: boolean}

interface Props {
  active: boolean
  visible: boolean
  tr: Translate
  skills?: readonly ExternalSkillRow[]
  status: (id: string) => string
  canAdd: (id: string) => boolean
  describe: (id: string, description: string) => string
  openDetails: (id: string, sources?: readonly MarketSourceReference[]) => void
}

export const marketKindByOption = {software: 'software', bridge: 'mcp', model: 'model', tool: 'tool'} as const

export function ExtensionMarketIcon({kind}: {kind: MarketKind}) {
  const iconByKind = {software: 'scene', model: 'engine', asset: 'crowd', tool: 'terminal'} as const
  return <span className='lya-market-icon' data-kind={kind} aria-hidden='true'>
    {kind === 'mcp' ? <IconCordisPluginOutlineRegular size={19}/> : kind === 'bundle' ? <IconPluginPinwheelOutlineRegular size={19}/>
      : kind === 'skill' ? <IconFolderOpenOutlineRegular size={19}/> : <WorkbenchIcon id={iconByKind[kind]} size={19}/>}
  </span>
}

export function ExtensionMarketSources({sources, tr}: {sources: readonly MarketSourceReference[]; tr: Translate}) {
  return <>{sources.map(source => <SettingsField key={source.name} label={source.name}>
    <a href={source.url} target='_blank' rel='noreferrer'>{tr('查看来源', 'View source')}</a>
    {source.version && <> · {tr('来源版本', 'Source version')} <code>{source.version}</code></>}
    {source.stale && <> · {tr('上次结果', 'Previous result')}</>}
  </SettingsField>)}</>
}

function buildRows(sources: readonly MarketSource[], skills: readonly ExternalSkillRow[], describe: Props['describe'], tr: Translate): MarketRow[] {
  const options = EXTERNAL_TOOL_OPTIONS.filter(option => option.id !== 'mcp').map<MarketRow>(option => ({
    id: `catalog:${option.id}`, optionsId: option.id, name: option.name,
    kind: marketKindByOption[option.kind], description: describe(option.id, option.description),
    sources: option.source ? [{name: tr('登记来源', 'Catalog source'), url: option.source}] : [],
  }))
  const rows = new Map(options.map(row => [row.id, row]))
  rows.set('asset:rocketbox', {
    id: 'asset:rocketbox', name: 'Rocketbox', kind: 'asset',
    description: tr('人物角色及预设动作。请在场景的「创建或导入人体」中选择角色。', 'Characters and preset motions. Choose a character in Create or import humans in the scene.'),
    sources: [{name: 'Microsoft Rocketbox', url: `https://github.com/${ROCKETBOX_SOURCE.repository}/tree/${ROCKETBOX_SOURCE.revision}`, version: ROCKETBOX_SOURCE.revision}],
  })
  for (const skill of skills) {
    const skillId = `skill:${skill.provider}:${skill.name}`
    rows.set(skillId, {id: skillId, skillId, name: skill.name, kind: 'skill', description: skill.description, sources: []})
  }
  for (const source of sources) {
    for (const entry of source.entries) {
      const id = entry.catalogId ? `catalog:${entry.catalogId}` : entry.id
      const reading = {name: source.name, url: entry.url ?? source.url, version: entry.version, stale: source.stale}
      const existing = rows.get(id)
      if (existing) existing.sources.push(reading)
      else rows.set(id, {id, name: entry.name, kind: entry.kind, description: entry.description, sources: [reading]})
    }
  }
  return [...rows.values()]
}

export function ExtensionDiscoverySettings({active, visible, tr, skills = [], status, canAdd, describe, openDetails}: Props) {
  const [sources, setSources] = useState<MarketSource[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<MarketCategory | 'all'>('all')
  const [limits, setLimits] = useState<Partial<Record<MarketCategory, number>>>({})
  const [selectedId, setSelectedId] = useState<string>()
  const categoryControlId = useId()
  const request = useRef<AbortController | undefined>(undefined)
  const started = useRef(false)
  const detailHeading = useRef<HTMLHeadingElement>(null)

  async function refresh() {
    if (request.current) return
    started.current = true
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    setError('')
    try {
      const response = await fetch('/api/lyapunov/external-tools/discover', {signal: controller.signal})
      if (!response.ok) throw Error(`HTTP ${response.status}`)
      const refreshed: DiscoverySource[] = await response.json()
      if (controller.signal.aborted) return
      setSources(previous => {
        const byId = new Map(previous.map(source => [source.id, source]))
        return refreshed.map(source => {
          const old = byId.get(source.id)
          return source.error && old?.entries.length ? {...source, entries: old.entries, stale: true} : source
        })
      })
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (request.current === controller) {
        request.current = undefined
        setLoading(false)
      }
    }
  }

  useEffect(() => () => {
    request.current?.abort()
    request.current = undefined
    started.current = false
  }, [])
  useEffect(() => {
    if (active && !started.current) void refresh()
  }, [active])
  useEffect(() => {
    if (visible && selectedId) detailHeading.current?.focus()
  }, [selectedId, visible])

  if (!visible) return null
  const rows = buildRows(sources, skills, describe, tr)
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const filtered = terms.length ? rows.filter(row => {
    const text = [row.name, row.description, ...row.sources.map(source => source.name)].join(' ').toLowerCase()
    return terms.every(term => text.includes(term))
  }) : rows
  const selected = rows.find(row => row.id === selectedId)
  const show = (row: MarketRow) => {
    if (row.optionsId) openDetails(row.optionsId, row.sources)
    else setSelectedId(row.id)
  }
  const kind = (value: MarketRow['kind']) => ({
    software: tr('软件', 'Software'), mcp: 'MCP', bundle: tr('DSH 组合包', 'DSH bundle'),
    model: tr('模型', 'Model'), tool: tr('工具', 'Tool'), asset: tr('人物资产', 'Character asset'), skill: 'Skill',
  })[value]
  const groupTitle = (value: MarketCategory) => ({
    mcp: 'MCP', skill: 'Skill', software: tr('软件', 'Software'), model: tr('模型', 'Models'),
    bundle: tr('DSH 插件', 'DSH plugins'), asset: tr('人物资产', 'Character assets'),
  })[value]
  const categoryTabs = [
    {value: 'all' as const, label: tr('全部', 'All')},
    ...marketCategories.map(value => ({value, label: value==='bundle'?'DSH':value==='asset'?tr('人物','People'):groupTitle(value)})),
  ]
  const groups = marketCategories.filter(value => category === 'all' || category === value)
    .map(value => ({category: value, rows: filtered.filter(row => (row.kind === 'tool' ? 'software' : row.kind) === value)}))
    .filter(group => group.rows.length > 0)

  const renderCard = (row: MarketRow) => <div className='lya-market-card' key={row.id}>
    <button type='button' className='lya-market-card-body' aria-label={row.name} onClick={() => show(row)}>
      <ExtensionMarketIcon kind={row.kind}/>
      <span className='lya-market-card-text'>
        <span className='lya-market-card-name'>{row.name}</span>
        {row.description && <span className='lya-market-card-summary'>{row.description}</span>}
        <span className='lya-market-card-status'>{row.optionsId ? status(row.optionsId) : `${kind(row.kind)}${row.kind==='mcp'||row.kind==='bundle'?tr(' · 候选',' · Candidate'):''}`}</span>
      </span>
    </button>
    {row.optionsId && canAdd(row.optionsId) ? <Button className='lya-market-card-add' size='sm' variant='outline'
      aria-label={tr(`添加 ${row.name}`, `Add ${row.name}`)} title={tr(`添加 ${row.name}`, `Add ${row.name}`)} icon={<IconPlusOutlineRegular size={16}/>} onClick={() => show(row)}/>
      : <IconChevronRightOutlineRegular size={15} className='lya-market-card-chevron' aria-hidden='true'/>}
  </div>

  return <>
    {selected ? <>
      <div className='lya-settings-actions'><Button size='sm' onClick={() => setSelectedId(undefined)}>{tr('返回结果', 'Back to results')}</Button></div>
      <div className='lya-market-intro'><ExtensionMarketIcon kind={selected.kind}/><h3 ref={detailHeading} tabIndex={-1}>{selected.name}</h3></div>
      {selected.description && <p className='lya-settings-caption'>{selected.description}</p>}
      <dl className='lya-settings-fields'>
        <SettingsField label={tr('类型', 'Type')}>{kind(selected.kind)}</SettingsField>
        <ExtensionMarketSources sources={selected.sources} tr={tr}/>
      </dl>
      {selected.skillId ? <div className='lya-settings-actions'>
        <Button size='sm' variant='primary' onClick={() => openDetails(selected.skillId!)}>{tr('查看会话可用性', 'View session availability')}</Button>
      </div> : selected.kind !== 'asset' && <p className='lya-settings-caption'>{tr('目录候选，等待登记兼容性和安装路线。', 'Catalog candidate awaiting compatibility and installation review.')}</p>}
    </> : <>
      <div className='lya-settings-toolbar'>
        <Input className='lya-settings-search' type='search' icon={<IconSearchOutlineRegular size={16}/>} aria-label={tr('搜索扩展', 'Search extensions')} placeholder={tr('搜索扩展', 'Search extensions')} value={query} onChange={event => {setQuery(event.target.value); setLimits({})}}/>
        <Button size='sm' disabled={loading} onClick={() => void refresh()}>{tr('刷新上游目录', 'Refresh upstream catalogs')}</Button>
      </div>
      <div className='lya-market-category-scroll'>
        <SegmentedControl className='lya-market-category-tabs' id={categoryControlId} label={tr('扩展分类','Extension categories')} value={category} options={categoryTabs} onChange={setCategory}/>
      </div>
      {loading && <p className='lya-settings-message' role='status'>{tr('正在读取上游目录…', 'Reading upstream catalogs…')}</p>}
      {error && <p className='lya-settings-message' role='alert'>{tr('无法读取上游目录。', 'Could not read upstream catalogs.')} {error}</p>}
      {sources.length > 0 && <SettingsDetails title={tr('上游目录', 'Upstream catalogs')}>
        {sources.map(source => <p key={source.id} className='lya-settings-caption'>
          <a href={source.url} target='_blank' rel='noreferrer'>{source.name}</a> · {new Date(source.checkedAt).toLocaleString()} · {source.error
            ? <>{tr('读取失败', 'Request failed')} ({source.error}){source.stale && <> · {tr('显示上次结果', 'Showing previous results')}</>}</>
            : `${source.entries.length} ${tr('条', 'entries')}`}
        </p>)}
      </SettingsDetails>}
      <div role='tabpanel' id={`${categoryControlId}-${category}-panel`} aria-labelledby={`${categoryControlId}-${category}`}>
        <div className='lya-market-groups' aria-label={tr('扩展结果', 'Extension results')}>
          {groups.map(({category: group, rows}) => {
            const limit = limits[group] ?? (category === 'all' ? overviewPageSize : pageSize)
            const headingId = `${categoryControlId}-${group}-heading`
            return <section className='lya-market-group' key={group} aria-labelledby={headingId}>
              <h3 id={headingId}>{groupTitle(group)}</h3>
              <div className='lya-market-cards'>{rows.slice(0, limit).map(renderCard)}</div>
              {rows.length > limit && <Button size='sm' onClick={() => setLimits(previous => ({...previous, [group]: limit + pageSize}))}>{tr('显示更多', 'Show more')} ({rows.length - limit})</Button>}
            </section>
          })}
          {!groups.length && <p className='lya-settings-caption'>{tr('此分类没有匹配的条目。', 'No matching extensions in this category.')}</p>}
        </div>
      </div>
    </>}
  </>
}
