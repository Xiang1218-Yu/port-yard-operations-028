import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Dashboard = { activeVoyages: number; berthMoves: number; yardUtilization: number; gateQueue: number; pendingTasks: number; blockedTasks: number; reeferAlerts: number; hazmatHolds: number; lateVessels: number };
type Voyage = { id: string; vessel: string; service: string; eta: string; etd: string; status: string; berth: string; movesPlanned: number; movesDone: number; lateRisk: string };
type Container = { id: string; voyageId: string; size: '20'|'40'|'45'; isoType: string; direction: 'import'|'export'|'transshipment'; status: string; weightT: number; reefer: boolean; temperature?: number; hazmatClass?: string; customs: 'released'|'inspection'|'hold'; priority: string; yardSlot: string; appointmentId?: string; lastEvent: string };
type Block = { id: string; zone: string; rows: number; tiers: number; capacity: number; occupied: number; reeferPlugs: number; usedPlugs: number; hazmatAllowed: boolean; equipment: string[]; heat: number; utilization: number; freeSlots: number; pressure: string };
type BlockAdvisory = { tone: 'inspection'|'full'|'critical'|'normal'; title: string; reasons: string[] };
type BlockDetail = { block: Block; containers: Container[]; reefer: { plugsTotal: number; plugsUsed: number; plugsFree: number; reeferContainers: Container[]; alerts: string[] }; hazmat: { hazmatAllowed: boolean; hazmatContainers: Container[]; heldCount: number }; openTasks: Task[]; equipment: Equipment[]; availableCount: number; advisory: BlockAdvisory };
type BlockDetailState = { status: 'loading' } | { status: 'ready'; detail: BlockDetail } | { status: 'gone'; id: string } | { status: 'error'; id: string; message: string };
type ContainerDetail = { container: Container; voyage?: Voyage; appointment?: Appointment; plan?: { recommendedBlock?: { id: string; zone: string } }; tasks: Task[] };
type ContainerDetailState = { status: 'loading'; id: string } | { status: 'ready'; detail: ContainerDetail } | { status: 'gone'; id: string } | { status: 'error'; id: string; message: string };
type Conflict = { severity: string; appointmentId: string; reason: string };
type Appointment = { id: string; containerId: string; truckNo: string; driver: string; type: 'pickup'|'dropoff'; windowStart: string; windowEnd: string; lane: 'north'|'south'|'rail'; status: string; exception?: string; sealVerified?: boolean; weightVerified?: boolean };
type Task = { id: string; kind: string; containerId: string; from: string; to: string; equipmentId?: string; priority: number; score: number; status: string; blockingReasons: string[]; estimatedMinutes: number; scheduledAt: string };
type Equipment = { id: string; name: string; kind: string; status: string; location: string; battery: number; queue: number; movesPerHour: number };
type Section = 'control'|'containers'|'gate'|'yard'|'tasks';
type Editor = { entity: 'container'|'appointment'|'task'; mode: 'create'|'edit'; id?: string; values: Record<string, string|boolean> };

const api = '/api';
const pct = (value: number) => `${Math.round(value * 100)}%`;
const time = (value: string) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const toLocalInput = (value?: string) => {
  const date = value ? new Date(value) : new Date(Date.now() + 30 * 60000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const customsLabel = (value: Container['customs']) => value === 'released' ? '已放行' : value === 'inspection' ? '查验中' : '扣留';
const statusLabel = (value: string) => ({ 'in-transit': '在途', 'at-gate': '在闸口', 'in-yard': '在场', 'on-quay': '在码头', released: '已放行', hold: '挂起', queued: '排队中', assigned: '已指派', executing: '作业中', blocked: '阻塞', done: '完成' } as Record<string, string>)[value] ?? value;
const kindLabel = (value: string) => ({ 'quay-crane': '岸桥', 'yard-crane': '场桥', 'terminal-truck': '集卡', 'reach-stacker': '正面吊' } as Record<string, string>)[value] ?? value;
const equipmentStatusLabel = (value: string) => ({ available: '可用', working: '作业中', maintenance: '维护中', offline: '离线' } as Record<string, string>)[value] ?? value;
const taskKindLabel = (value: string) => ({ receive: '收箱', deliver: '提箱', rehandle: '翻箱', load: '装船', discharge: '卸船', inspect: '查验' } as Record<string, string>)[value] ?? value;
const pressureLabel = (value: string) => value === 'critical' ? '高压' : value === 'warning' ? '偏高' : '正常';
const containerTraits = (container: Container) => container.reefer ? `冷藏 ${container.temperature ?? 4}°C` : container.hazmatClass ? `危险品 ${container.hazmatClass} 类` : '普通箱';
const defaultValues = (entity: Editor['entity']): Record<string, string|boolean> => {  if (entity === 'container') return { id: '', voyageId: 'VOY-AX7', size: '40', isoType: '45G1', direction: 'import', status: 'in-yard', weightT: '20', reefer: false, temperature: '4', hazmatClass: '', customs: 'released', priority: 'normal', yardSlot: 'C03-R01-T1' };
  if (entity === 'appointment') return { containerId: '', truckNo: '', driver: '', type: 'pickup', windowStart: toLocalInput(), windowEnd: toLocalInput(new Date(Date.now() + 60 * 60000).toISOString()), lane: 'north' };
  return { kind: 'receive', containerId: '', from: '闸口', to: 'C03-R01-T1', equipmentId: '', priority: '50', scheduledAt: toLocalInput(), estimatedMinutes: '20', status: 'queued' };
};

class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${api}${path}`, { ...init, headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, body.message || `请求失败 (${response.status})`);
  return body as T;
}

export default function App() {
  const [dashboard, setDashboard] = useState<Dashboard>();
  const [voyages, setVoyages] = useState<Voyage[]>([]);
  const [containers, setContainers] = useState<Container[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [tab, setTab] = useState<Section>('control');
  const [selectedVoyage, setSelectedVoyage] = useState('VOY-AX7');
  const [editor, setEditor] = useState<Editor>();
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [activeBlockId, setActiveBlockId] = useState<string>();
  const [blockDetailState, setBlockDetailState] = useState<BlockDetailState>();
  const [containerDetailState, setContainerDetailState] = useState<ContainerDetailState>();
  const [yardBusy, setYardBusy] = useState(false);
  const blockReqSeq = useRef(0);
  const containerReqSeq = useRef(0);
  const activeBlockIdRef = useRef<string | undefined>(undefined);
  const activeContainerIdRef = useRef<string | undefined>(undefined);

  const fetchBlockDetail = useCallback(async (id: string) => {
    const seq = ++blockReqSeq.current;
    activeBlockIdRef.current = id;
    setActiveBlockId(id);
    setBlockDetailState({ status: 'loading' });
    try {
      const detail = await request<BlockDetail>(`/yard/blocks/${id}`);
      if (seq !== blockReqSeq.current) return;
      if (!detail?.block) setBlockDetailState({ status: 'gone', id });
      else setBlockDetailState({ status: 'ready', detail });
    } catch (reason) {
      if (seq !== blockReqSeq.current) return;
      if (reason instanceof ApiError && reason.status === 404) setBlockDetailState({ status: 'gone', id });
      else setBlockDetailState({ status: 'error', id, message: reason instanceof Error ? reason.message : '区块详情加载失败' });
    }
  }, []);

  const fetchContainerDetail = useCallback(async (id: string) => {
    const seq = ++containerReqSeq.current;
    activeContainerIdRef.current = id;
    setContainerDetailState({ status: 'loading', id });
    try {
      const detail = await request<ContainerDetail>(`/containers/${id}`);
      if (seq !== containerReqSeq.current) return;
      if (!detail?.container) setContainerDetailState({ status: 'gone', id });
      else setContainerDetailState({ status: 'ready', detail });
    } catch (reason) {
      if (seq !== containerReqSeq.current) return;
      if (reason instanceof ApiError && reason.status === 404) setContainerDetailState({ status: 'gone', id });
      else setContainerDetailState({ status: 'error', id, message: reason instanceof Error ? reason.message : '箱务详情加载失败' });
    }
  }, []);

  const closeBlockDetail = () => {
    blockReqSeq.current++; activeBlockIdRef.current = undefined;
    setActiveBlockId(undefined); setBlockDetailState(undefined);
    setContainerDetailState(undefined);
  };
  const closeContainerDetail = () => { containerReqSeq.current++; activeContainerIdRef.current = undefined; setContainerDetailState(undefined); };

  const load = useCallback(async () => {
    const [d, v, ctn, b, cf, a, t, e] = await Promise.all([
      request<Dashboard>('/dashboard'), request<Voyage[]>('/voyages'), request<Container[]>('/containers'),
      request<Block[]>('/yard/heatmap'), request<Conflict[]>('/gate/conflicts'), request<Appointment[]>('/gate/appointments'),
      request<Task[]>('/tasks'), request<Equipment[]>('/equipment')
    ]);
    setDashboard(d); setVoyages(v); setContainers(ctn); setBlocks(b); setConflicts(cf); setAppointments(a); setTasks(t); setEquipment(e);
    // Re-sync open detail views against the fresh snapshot; a block that vanished in the
    // refresh window must surface its own empty state instead of keeping stale rows.
    const blockId = activeBlockIdRef.current;
    if (blockId) {
      if (!b.some(block => block.id === blockId)) { setBlockDetailState({ status: 'gone', id: blockId }); setContainerDetailState(undefined); }
      else void fetchBlockDetail(blockId);
    }
    const containerId = activeContainerIdRef.current;
    if (containerId) void fetchContainerDetail(containerId);
  }, [fetchBlockDetail, fetchContainerDetail]);
  useEffect(() => { void load().catch(reason => setError(reason instanceof Error ? reason.message : '无法连接服务端')); }, [load]);

  const refreshYard = async () => {
    setYardBusy(true);
    try { await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '刷新失败，无法连接服务端'); }
    finally { setYardBusy(false); }
  };

  const mutate = async (path: string, method: string, body?: unknown) => {
    setBusy(true); setError('');
    try {
      await request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      await load(); setEditor(undefined); setMessage('操作已保存，作业台数据已刷新');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败'); }
    finally { setBusy(false); }
  };
  const openCreate = (entity: Editor['entity']) => { setError(''); setEditor({ entity, mode: 'create', values: defaultValues(entity) }); };
  const openEdit = (entity: Editor['entity'], id: string, values: Record<string, string|boolean>) => { setError(''); setEditor({ entity, mode: 'edit', id, values: { ...values } }); };
  const updateField = (key: string, value: string|boolean) => setEditor(current => current ? { ...current, values: { ...current.values, [key]: value } } : current);
  const saveEditor = async (event: FormEvent) => {
    event.preventDefault(); if (!editor) return;
    const { entity, mode, id, values } = editor;
    const payload: Record<string, unknown> = entity === 'container' ? {
      ...(mode === 'create' ? { id: values.id } : {}), voyageId: values.voyageId, size: values.size, isoType: values.isoType,
      direction: values.direction, status: values.status, weightT: Number(values.weightT), reefer: Boolean(values.reefer),
      ...(values.reefer ? { temperature: Number(values.temperature) } : {}), ...(values.hazmatClass ? { hazmatClass: values.hazmatClass } : {}),
      customs: values.customs, priority: values.priority, yardSlot: values.yardSlot
    } : entity === 'appointment' ? {
      containerId: values.containerId, truckNo: values.truckNo, driver: values.driver, type: values.type,
      windowStart: new Date(String(values.windowStart)).toISOString(), windowEnd: new Date(String(values.windowEnd)).toISOString(), lane: values.lane
    } : {
      kind: values.kind, containerId: values.containerId, from: values.from, to: values.to, priority: Number(values.priority),
      scheduledAt: new Date(String(values.scheduledAt)).toISOString(), estimatedMinutes: Number(values.estimatedMinutes),
      ...(values.equipmentId ? { equipmentId: values.equipmentId } : {}), ...(mode === 'edit' ? { status: values.status } : {})
    };
    await mutate(entity === 'container' ? `/containers${mode === 'edit' ? `/${id}` : ''}` : entity === 'appointment' ? `/gate/appointments${mode === 'edit' ? `/${id}` : ''}` : `/tasks${mode === 'edit' ? `/${id}` : ''}`, mode === 'create' ? 'POST' : 'PATCH', payload);
  };
  const remove = async (entity: Editor['entity'], id: string) => {
    if (!window.confirm(`确认删除 ${id}？相关数据的联动处理会写入审计记录。`)) return;
    const path = entity === 'container' ? `/containers/${id}` : entity === 'appointment' ? `/gate/appointments/${id}` : `/tasks/${id}`;
    await mutate(path, 'DELETE');
  };
  const updateAppointmentStatus = async (id: string, status: string) => mutate(`/gate/appointments/${id}`, 'PATCH', { status });
  const assign = async (id: string, equipmentId: string) => equipmentId ? mutate(`/tasks/${id}/assign`, 'PATCH', { equipmentId }) : mutate(`/tasks/${id}`, 'PATCH', { equipmentId: '', status: 'queued' });
  const selected = voyages.find(voyage => voyage.id === selectedVoyage);
  const remaining = selected ? selected.movesPlanned - selected.movesDone : 0;
  const maxHeat = useMemo(() => Math.max(...blocks.map(block => block.heat), 1), [blocks]);

  if (!dashboard && error) return <main className="connection-error"><div className="eyebrow">API CONNECTION ERROR</div><h1>无法连接港口作业服务</h1><p>{error}</p><p>请从项目根目录运行 <code>npm run dev</code>，确认前端 5178 和 API 4107 均已启动。</p><button onClick={() => { setError(''); void load().catch(reason => setError(reason instanceof Error ? reason.message : '无法连接服务端')); }}>重新连接</button></main>;
  if (!dashboard) return <div className="loading">正在连接码头实时作业中台…</div>;

  return <main>
    <header><div><div className="eyebrow">PORT OPS / YARD & GATE CONTROL</div><h1>HarborGrid <span>港口集装箱堆场协同与闸口调度</span></h1><p>把船期、箱务、堆场容量、危险品/冷藏约束、闸口预约与场内设备任务放在同一条作业链路上。</p></div><div className="header-right"><span className="live"><i/> TOS LINKED</span><span className="clock">LIVE · {new Date().toLocaleTimeString()}</span></div></header>
    {message && <div className="toast" onClick={() => setMessage('')}>{message} ×</div>}{error && <div className="form-error page-error">{error}<button onClick={() => setError('')}>关闭</button></div>}
    <section className="kpis"><div><small>ACTIVE VESSELS</small><b>{dashboard.activeVoyages}<em> 艘</em></b><span>{dashboard.lateVessels} 艘存在延误风险</span></div><div><small>YARD UTILIZATION</small><b>{pct(dashboard.yardUtilization)}</b><span>可用堆位 / 危险品隔离纳管</span></div><div><small>GATE QUEUE</small><b>{dashboard.gateQueue}<em> 车</em></b><span>预约、已进场与车道排队</span></div><div><small>EXCEPTIONS</small><b>{dashboard.blockedTasks + dashboard.reeferAlerts + dashboard.hazmatHolds}<em> 项</em></b><span>{dashboard.blockedTasks} 作业阻塞 · {dashboard.reeferAlerts} 冷藏告警</span></div></section>
    <nav className="tabs"><button className={tab==='control'?'active':''} onClick={() => setTab('control')}>作业驾驶舱</button><button className={tab==='containers'?'active':''} onClick={() => setTab('containers')}>箱务台账 / CRUD</button><button className={tab==='gate'?'active':''} onClick={() => setTab('gate')}>闸口预约</button><button className={tab==='yard'?'active':''} onClick={() => setTab('yard')}>堆场热区</button><button className={tab==='tasks'?'active':''} onClick={() => setTab('tasks')}>设备任务</button><span>最后同步 {new Date().toLocaleTimeString()}</span></nav>
    {tab === 'control' && <div className="layout"><section className="panel vessel-panel"><div className="panel-head"><div><div className="eyebrow">VESSEL WINDOW / 船期窗口</div><h2>泊位作业进度</h2></div><span className="muted">剩余作业动态计算</span></div>{voyages.map(voyage => <button key={voyage.id} className={`vessel ${selectedVoyage===voyage.id?'selected':''}`} onClick={() => setSelectedVoyage(voyage.id)}><span className={`vessel-dot ${voyage.status}`}/><span className="vessel-main"><b>{voyage.vessel}</b><small>{voyage.id} · {voyage.service} · {voyage.berth}</small><i><em style={{ width: `${Math.min(100, voyage.movesDone / voyage.movesPlanned * 100)}%` }}/></i></span><span className="vessel-move"><b>{voyage.movesDone.toLocaleString()}</b><small>/ {voyage.movesPlanned.toLocaleString()} moves</small></span><strong className={voyage.lateRisk}>{voyage.lateRisk==='high'?'HIGH':voyage.lateRisk==='medium'?'WATCH':'ON TIME'}</strong></button>)}</section><section className="panel focus-panel"><div className="panel-head"><div><div className="eyebrow">SELECTED VOYAGE / {selected?.id}</div><h2>{selected?.vessel}</h2></div><span className={`badge ${selected?.lateRisk}`}>{selected?.status}</span></div><div className="voyage-stats"><div><small>ETA</small><b>{selected&&time(selected.eta)}</b><span>预计靠泊</span></div><div><small>ETD</small><b>{selected&&time(selected.etd)}</b><span>计划离港</span></div><div><small>REMAINING</small><b>{remaining}</b><span>剩余翻箱</span></div></div><div className="berth-map"><div className="water"><span>岸线 / BERTH</span><i className="ship" style={{ left: `${selected?.berth==='B07'?50:24}%` }}>{selected?.vessel}</i><b>B01</b><b>B04</b><b>B07</b><b>B10</b></div></div><div className="callout"><strong>调度策略</strong><span>已把 {dashboard.blockedTasks} 个阻塞任务、{dashboard.gateQueue} 车闸口压力纳入当前窗口；优先保护冷藏与危险品安全约束。</span></div></section><section className="panel wide"><div className="panel-head"><h3>异常与联动信号</h3><span>{conflicts.length} gate conflicts detected</span></div><div className="signal-grid"><div><strong className="critical">{dashboard.blockedTasks}</strong><span>设备/约束阻塞</span><small>最高优先级：海关查验任务</small></div><div><strong className="warning">{conflicts.length}</strong><span>闸口预约冲突</span><small>同车重叠窗口需人工重排</small></div><div><strong className="warning">{dashboard.reeferAlerts}</strong><span>冷藏与温控风险</span><small>查验区电源余量接近阈值</small></div><div><strong className="ok">{equipment.filter(item => item.status==='available').length}</strong><span>可调度设备</span><small>场桥 / 正面吊 / 集卡</small></div></div></section></div>}
    {tab === 'containers' && <section className="panel wide"><div className="panel-head"><div><div className="eyebrow">CONTAINER REGISTER / CRUD</div><h2>箱务台账</h2><span className="muted">新增、查询、编辑、删除；危险品与冷藏箱受堆场约束校验</span></div><button className="primary-action" onClick={() => openCreate('container')}>＋ 新增箱务</button></div><div className="table container-table"><div className="tr th"><span>箱号 / 航次</span><span>尺寸 / 流向</span><span>箱况 / 海关</span><span>堆位</span><span>重量 / 属性</span><span>操作</span></div>{containers.map(container => <div className="tr" key={container.id}><span><b>{container.id}</b><small>{container.voyageId} · {container.lastEvent}</small></span><span>{container.size}ft · {container.direction}<small>{container.isoType}</small></span><span><b>{container.status}</b><small>海关：{container.customs}</small></span><span>{container.yardSlot}</span><span>{container.weightT}t<small>{container.reefer?`冷藏 ${container.temperature}°C`:container.hazmatClass?`危险品 ${container.hazmatClass} 类`:'普通箱'}</small></span><span className="row-actions"><button onClick={() => void fetchContainerDetail(container.id)}>详情</button><button onClick={() => openEdit('container', container.id, { ...container, weightT: String(container.weightT), temperature: String(container.temperature ?? 4), hazmatClass: container.hazmatClass ?? '' })}>编辑</button><button className="danger-action" onClick={() => void remove('container', container.id)}>删除</button></span></div>)}</div></section>}
    {tab === 'gate' && <section className="panel wide"><div className="panel-head"><div><div className="eyebrow">GATE APPOINTMENT / SLOT CONTROL</div><h2>闸口预约与车道状态</h2><span className="muted">支持新增预约、编辑时隙、签到/完成和删除</span></div><button className="primary-action" onClick={() => openCreate('appointment')}>＋ 新增预约</button></div>{conflicts.map(conflict => <div className="conflict" key={`${conflict.appointmentId}-${conflict.reason}`}><strong>{conflict.severity}</strong><b>{conflict.appointmentId}</b><span>{conflict.reason}</span></div>)}<div className="table"><div className="tr th"><span>预约</span><span>箱号 / 车辆</span><span>窗口</span><span>车道</span><span>状态</span><span>操作</span></div>{appointments.map(appointment => <div className="tr" key={appointment.id}><span><b>{appointment.id}</b><small>{appointment.type}</small></span><span><b>{appointment.containerId}</b><small>{appointment.truckNo} · {appointment.driver}</small></span><span>{time(appointment.windowStart)}—{time(appointment.windowEnd)}</span><span>{appointment.lane}</span><span className={`pill ${appointment.status}`}>{appointment.status}</span><span className="row-actions">{appointment.status==='booked'?<button onClick={() => void updateAppointmentStatus(appointment.id, 'checked-in')}>签到</button>:appointment.status==='checked-in'?<button onClick={() => void updateAppointmentStatus(appointment.id, 'completed')}>完成</button>:null}<button onClick={() => openEdit('appointment', appointment.id, { ...appointment, windowStart: toLocalInput(appointment.windowStart), windowEnd: toLocalInput(appointment.windowEnd) })}>编辑</button><button className="danger-action" onClick={() => void remove('appointment', appointment.id)}>删除</button></span></div>)}</div></section>}
    {tab === 'yard' && <section className="panel wide"><div className="panel-head"><div><div className="eyebrow">YARD HEATMAP / STACK DENSITY</div><h2>堆场容量与安全约束</h2><span className="muted">点击区块卡片查看箱号、冷藏/危险品占用、关联任务与可用设备</span></div><div className="yard-head-actions"><button className="ghost-action" disabled={yardBusy} onClick={() => void refreshYard()}>{yardBusy?'同步中…':'刷新热区'}</button><span className="muted">实时区块压力</span></div></div><div className="yard-grid">{blocks.map(block => <button type="button" className={`block ${block.pressure}${activeBlockId===block.id?' selected':''}`} key={block.id} onClick={() => void fetchBlockDetail(block.id)}><div className="block-top"><b>{block.id}</b><strong>{pct(block.utilization)}</strong></div><span>{block.zone}</span><div className="heat"><i style={{ width: `${block.heat / maxHeat * 100}%` }}/></div><div className="block-stats"><span>空位 {block.freeSlots}</span><span>冷插 {block.usedPlugs}/{block.reeferPlugs}</span><span>{block.hazmatAllowed?'危险品可入':'普通区'}</span></div><em className="block-open">查看详情 →</em></button>)}</div><div className="yard-note"><span>堆位推荐会同时考虑容量、热区、危险品隔离、冷藏插座和设备可达性。</span><b>A01 → C03 重排建议可释放 21 个低热度堆位</b></div></section>}
    {tab === 'tasks' && <div className="layout"><section className="panel wide"><div className="panel-head"><div><div className="eyebrow">TASK DISPATCH / EQUIPMENT POOL</div><h2>场内任务优先级与设备指派</h2><span className="muted">支持新增、编辑、删除和设备指派</span></div><button className="primary-action" onClick={() => openCreate('task')}>＋ 新建任务</button></div><div className="table task-table"><div className="tr th"><span>任务</span><span>箱号</span><span>路径</span><span>优先级</span><span>状态</span><span>设备 / 操作</span></div>{tasks.map(task => <div className="tr" key={task.id}><span><b>{task.id}</b><small>{task.kind} · {task.estimatedMinutes}min</small></span><span>{task.containerId}</span><span>{task.from} → {task.to}</span><span className={task.score>95?'critical':''}>{task.score}</span><span><span className={`pill ${task.status}`}>{task.status}</span>{task.blockingReasons.length>0&&<small className="blocked-text">{task.blockingReasons[0]}</small>}</span><span className="task-actions"><select value={task.equipmentId??''} onChange={event => void assign(task.id, event.target.value)}><option value="">未指派</option>{equipment.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button onClick={() => openEdit('task', task.id, { kind: task.kind, containerId: task.containerId, from: task.from, to: task.to, equipmentId: task.equipmentId ?? '', priority: String(task.priority), estimatedMinutes: String(task.estimatedMinutes), scheduledAt: toLocalInput(task.scheduledAt), status: task.status })}>编辑</button><button className="danger-action" onClick={() => void remove('task', task.id)}>删除</button></span></div>)}</div></section><section className="panel"><div className="panel-head"><h3>设备池</h3><span>{equipment.length} assets</span></div>{equipment.map(item => <div className="equipment" key={item.id}><i className={`equip-dot ${item.status}`}/><div><b>{item.name}</b><small>{item.location} · 队列 {item.queue}</small></div><strong>{item.battery}%</strong></div>)}</section></div>}
    <footer>HarborGrid · 内存种子数据 + REST API · 箱务台账、闸口预约、场内任务提供完整增删改查操作</footer>
    {activeBlockId && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) closeBlockDetail(); }}>
      <div className="editor-modal block-modal">
        {blockDetailState?.status === 'loading' && <div className="modal-head"><div><div className="eyebrow">BLOCK DETAIL / {activeBlockId}</div><h2>{activeBlockId}</h2></div></div>}
        {blockDetailState?.status === 'loading' && <div className="detail-empty detail-loading">正在加载区块 {activeBlockId} 的箱号、任务与设备明细…</div>}
        {blockDetailState?.status === 'gone' && <div className="detail-empty detail-gone"><div className="eyebrow">BLOCK NOT FOUND</div><h2>区块 {blockDetailState.id} 已不可用</h2><p>该区块在最近一次热区刷新中消失（可能已被合并或撤销），详情数据未保留，避免沿用上一次区块内容。</p><button className="primary-action" onClick={closeBlockDetail}>返回热区</button></div>}
        {blockDetailState?.status === 'error' && <div className="detail-empty detail-gone"><div className="eyebrow">DETAIL LOAD ERROR</div><h2>区块 {blockDetailState.id} 详情加载失败</h2><p>{blockDetailState.message}</p><div className="detail-actions-inline"><button className="ghost-action" onClick={() => void fetchBlockDetail(blockDetailState.id)}>重试</button><button className="primary-action" onClick={closeBlockDetail}>关闭</button></div></div>}
        {blockDetailState?.status === 'ready' && (() => { const { block: b, containers: boxList, reefer, hazmat, openTasks, advisory } = blockDetailState.detail; return <>
          <div className="modal-head"><div><div className="eyebrow">BLOCK DETAIL / {b.id}</div><h2>{b.id} <span className="modal-subtitle">{b.zone}</span></h2></div><div className="modal-head-right"><span className={`pill ${b.pressure}`}>{pressureLabel(b.pressure)}</span><button type="button" className="icon-button" onClick={closeBlockDetail}>×</button></div></div>
          <div className={`advisory ${advisory.tone}`}><strong>{advisory.title}</strong><ul>{advisory.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul></div>
          <div className="detail-chips">
            <div><small>占用 / 容量</small><b>{b.occupied}/{b.capacity}</b><span>{pct(b.utilization)} · {b.rows} 排 × {b.tiers} 层</span></div>
            <div><small>剩余堆位</small><b>{b.freeSlots}</b><span>{b.freeSlots === 0 ? '已满负荷' : '可继续收箱'}</span></div>
            <div><small>冷藏插座</small><b>{b.usedPlugs}/{b.reeferPlugs}</b><span>剩余 {reefer.plugsFree} 个 · {reefer.reeferContainers.length} 个冷藏箱在场</span></div>
            <div><small>危险品隔离</small><b className={hazmat.hazmatAllowed ? 'ok' : ''}>{hazmat.hazmatAllowed ? '有资质' : '普通区'}</b><span>{hazmat.hazmatContainers.length} 个危险品箱 · {hazmat.heldCount} 箱未放行</span></div>
            <div><small>可达设备</small><b>{blockDetailState.detail.availableCount}/{blockDetailState.detail.equipment.length}</b><span>可用 / 配置总数</span></div>
          </div>
          {reefer.alerts.length > 0 && <div className="alert-list">{reefer.alerts.map((alert, index) => <span key={index}>⚠ {alert}</span>)}</div>}
          <section className="detail-section">
            <div className="detail-section-head"><h3>区块内箱号 <em>{boxList.length}</em></h3><span className="muted">点击箱号直接进入箱务详情</span></div>
            {boxList.length === 0 ? <div className="detail-empty detail-inline">区块内当前没有已落位箱号。若刚完成刷新，可能是箱号正在迁入，稍后重试。</div> :
            <div className="table block-container-table"><div className="tr th"><span>箱号 / 堆位</span><span>属性 / 海关</span><span>状态</span><span>最新动态</span><span>箱务</span></div>
              {boxList.map(box => <div className="tr" key={box.id}><span><button type="button" className="link-button" onClick={() => void fetchContainerDetail(box.id)}>{box.id}</button><small>{box.yardSlot} · {box.size}ft {box.direction}</small></span><span><b>{containerTraits(box)}</b><small>海关：{customsLabel(box.customs)}</small></span><span className={`pill ${box.status}`}>{statusLabel(box.status)}</span><span>{box.lastEvent}</span><span className="row-actions"><button onClick={() => void fetchContainerDetail(box.id)}>箱务详情</button></span></div>)}
            </div>}
          </section>
          <div className="detail-cols">
            <section className="detail-section">
              <div className="detail-section-head"><h3>关联未完成任务 <em>{openTasks.length}</em></h3><span className="muted">起讫点涉及本区块</span></div>
              {openTasks.length === 0 ? <div className="detail-empty detail-inline">暂无关联未完成任务。</div> : openTasks.map(task => <div className="detail-row" key={task.id}>
                <div><b>{task.id}</b><small>{taskKindLabel(task.kind)} · {task.estimatedMinutes}min · 评分 {task.score}</small></div>
                <div className="detail-path">{task.from} → {task.to}<small>{task.equipmentId ? `设备 ${task.equipmentId}` : '未指派设备'}</small>{task.blockingReasons.length > 0 && <small className="blocked-text">{task.blockingReasons[0]}</small>}</div>
                <span className={`pill ${task.status}`}>{statusLabel(task.status)}</span>
              </div>)}
            </section>
            <section className="detail-section">
              <div className="detail-section-head"><h3>可达设备 <em>{blockDetailState.detail.equipment.length}</em></h3><span className="muted">{b.id} 配置机型</span></div>
              {blockDetailState.detail.equipment.length === 0 ? <div className="detail-empty detail-inline">本区块未配置可达设备，箱号移动前请先协调场桥或正面吊入场。</div> : blockDetailState.detail.equipment.map(machine => <div className="detail-row" key={machine.id}>
                <i className={`equip-dot ${machine.status}`}/>
                <div className="detail-equip"><b>{machine.name}</b><small>{kindLabel(machine.kind)} · {machine.location} · 队列 {machine.queue} · {machine.movesPerHour} 箱/时</small></div>
                <div className="detail-equip-right"><strong>{machine.battery}%</strong><span className={`pill ${machine.status}`}>{equipmentStatusLabel(machine.status)}</span></div>
              </div>)}
            </section>
          </div>
          <div className="modal-actions detail-modal-actions"><span className="muted">数据随热区刷新自动同步；区块消失时详情立即转为空态</span><button className="ghost-action" disabled={yardBusy} onClick={() => void refreshYard()}>{yardBusy?'同步中…':'重新同步'}</button><button className="primary-action" onClick={closeBlockDetail}>关闭</button></div>
        </>; })()}
      </div>
    </div>}
    {containerDetailState && (() => { const state = containerDetailState; return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) closeContainerDetail(); }}>
      <div className="editor-modal container-modal">
        {state.status === 'loading' && <div className="modal-head"><div><div className="eyebrow">CONTAINER DETAIL / {state.id}</div><h2>{state.id}</h2></div></div>}
        {state.status === 'loading' && <div className="detail-empty detail-loading">正在加载 {state.id} 的箱务详情…</div>}
        {state.status === 'gone' && <div className="detail-empty detail-gone"><div className="eyebrow">CONTAINER NOT FOUND</div><h2>箱号 {state.id} 已不存在</h2><p>该箱号在最近一次刷新中被移除或已提箱离场，未沿用上一次箱务数据。</p><button className="primary-action" onClick={closeContainerDetail}>关闭</button></div>}
        {state.status === 'error' && <div className="detail-empty detail-gone"><div className="eyebrow">DETAIL LOAD ERROR</div><h2>箱务详情加载失败</h2><p>{state.message}</p><div className="detail-actions-inline"><button className="ghost-action" onClick={() => void fetchContainerDetail(state.id)}>重试</button><button className="primary-action" onClick={closeContainerDetail}>关闭</button></div></div>}
        {state.status === 'ready' && (() => { const c = state.detail.container; const v = state.detail.voyage; const apt = state.detail.appointment; const cTasks = state.detail.tasks; const recommended = state.detail.plan?.recommendedBlock; return <>
          <div className="modal-head"><div><div className="eyebrow">CONTAINER DETAIL / {c.id}</div><h2>{c.id} <span className="modal-subtitle">{c.isoType} · {c.size}ft {c.direction}</span></h2></div><div className="modal-head-right"><span className={`pill ${c.customs}`}>{customsLabel(c.customs)}</span><button type="button" className="icon-button" onClick={closeContainerDetail}>×</button></div></div>
          <div className="detail-chips">
            <div><small>箱状态</small><b>{statusLabel(c.status)}</b><span>{c.lastEvent}</span></div>
            <div><small>关联航次</small><b>{c.voyageId}</b><span>{v ? `${v.vessel} · ${v.service} · 泊位 ${v.berth}` : '航次信息缺失'}</span></div>
            <div><small>堆位</small><b>{c.yardSlot || '未落位'}</b><span>{containerTraits(c)} · {c.weightT}t</span></div>
            <div><small>建议区块</small><b className={recommended ? 'ok' : ''}>{recommended ? recommended.id : '无匹配'}</b><span>{recommended ? recommended.zone : '暂无满足约束的区块'}</span></div>
          </div>
          <div className="detail-cols">
            <section className="detail-section"><div className="detail-section-head"><h3>闸口预约</h3></div>
              {apt ? <div className="detail-row stacked"><div><b>{apt.id}</b><small>{apt.type === 'pickup' ? '提箱' : '进场'} · {apt.lane === 'north' ? '北闸口' : apt.lane === 'south' ? '南闸口' : '铁路闸口'} · {apt.truckNo}（{apt.driver}）</small></div><div className="detail-path">{time(apt.windowStart)}—{time(apt.windowEnd)}<small>封志 {apt.sealVerified ? '已核验' : '未核验'} · 称重 {apt.weightVerified ? '已核验' : '未核验'}{apt.exception ? ` · ${apt.exception}` : ''}</small></div><span className={`pill ${apt.status}`}>{apt.status}</span></div> : <div className="detail-empty detail-inline">未关联闸口预约。</div>}
            </section>
            <section className="detail-section"><div className="detail-section-head"><h3>关联任务 <em>{cTasks.length}</em></h3></div>
              {cTasks.length === 0 ? <div className="detail-empty detail-inline">暂无关联作业任务。</div> : cTasks.map(task => <div className="detail-row stacked" key={task.id}><div><b>{task.id}</b><small>{taskKindLabel(task.kind)} · {task.estimatedMinutes}min · 评分 {task.score} · {task.equipmentId ?? '未指派设备'}</small></div><div className="detail-path">{task.from} → {task.to}{task.blockingReasons.length > 0 && <small className="blocked-text">{task.blockingReasons[0]}</small>}</div><span className={`pill ${task.status}`}>{statusLabel(task.status)}</span></div>)}
            </section>
          </div>
          <div className="modal-actions detail-modal-actions"><button className="ghost-action" onClick={closeContainerDetail}>关闭</button><button className="primary-action" onClick={() => openEdit('container', c.id, { ...c, weightT: String(c.weightT), temperature: String(c.temperature ?? 4), hazmatClass: c.hazmatClass ?? '' })}>编辑箱务记录</button></div>
        </>; })()}
      </div>
    </div>; })()}
    {editor && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setEditor(undefined); }}><form className="editor-modal" onSubmit={saveEditor}><div className="modal-head"><div><div className="eyebrow">{editor.mode.toUpperCase()} / {editor.entity.toUpperCase()}</div><h2>{editor.mode==='create'?'创建':'编辑'}{editor.entity==='container'?'箱务记录':editor.entity==='appointment'?'闸口预约':'作业任务'}</h2></div><button type="button" className="icon-button" onClick={() => setEditor(undefined)}>×</button></div>
      {editor.entity === 'container' && <div className="form-grid">
        <label>集装箱号<input required disabled={editor.mode==='edit'} value={String(editor.values.id)} onChange={event => updateField('id', event.target.value.toUpperCase())}/></label>
        <label>关联航次<select value={String(editor.values.voyageId)} onChange={event => updateField('voyageId', event.target.value)}>{voyages.filter(voyage => voyage.status!=='departed').map(voyage => <option key={voyage.id} value={voyage.id}>{voyage.id} · {voyage.vessel}</option>)}</select></label>
        <label>尺寸<select value={String(editor.values.size)} onChange={event => updateField('size', event.target.value)}><option value="20">20 ft</option><option value="40">40 ft</option><option value="45">45 ft</option></select></label>
        <label>ISO 箱型<input required value={String(editor.values.isoType)} onChange={event => updateField('isoType', event.target.value)}/></label>
        <label>作业流向<select value={String(editor.values.direction)} onChange={event => updateField('direction', event.target.value)}><option value="import">进口</option><option value="export">出口</option><option value="transshipment">中转</option></select></label>
        <label>箱状态<select value={String(editor.values.status)} onChange={event => updateField('status', event.target.value)}>{['in-transit','at-gate','in-yard','on-quay','released','hold'].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>重量 (吨)<input type="number" min="0.1" step="0.1" required value={String(editor.values.weightT)} onChange={event => updateField('weightT', event.target.value)}/></label>
        <label>海关状态<select value={String(editor.values.customs)} onChange={event => updateField('customs', event.target.value)}><option value="released">已放行</option><option value="inspection">查验中</option><option value="hold">扣留</option></select></label>
        <label>优先级<select value={String(editor.values.priority)} onChange={event => updateField('priority', event.target.value)}><option value="normal">普通</option><option value="hot">急箱</option><option value="reefer">冷藏</option><option value="hazmat">危险品</option></select></label>
        <label>堆位<input required placeholder="例如 B07-R03-T2" value={String(editor.values.yardSlot)} onChange={event => updateField('yardSlot', event.target.value.toUpperCase())}/></label>
        <label>危险品类别<input placeholder="非危险品留空" value={String(editor.values.hazmatClass)} onChange={event => updateField('hazmatClass', event.target.value)}/></label>
        <label className="check-label"><input type="checkbox" checked={Boolean(editor.values.reefer)} onChange={event => updateField('reefer', event.target.checked)}/>冷藏箱</label>
        {Boolean(editor.values.reefer) && <label>目标温度 (°C)<input type="number" step="0.1" value={String(editor.values.temperature)} onChange={event => updateField('temperature', event.target.value)}/></label>}
      </div>}
      {editor.entity === 'appointment' && <div className="form-grid">
        <label>集装箱<select required value={String(editor.values.containerId)} onChange={event => updateField('containerId', event.target.value)}><option value="">选择箱号</option>{containers.map(container => <option key={container.id} value={container.id}>{container.id} · {container.status}</option>)}</select></label>
        <label>预约类型<select value={String(editor.values.type)} onChange={event => updateField('type', event.target.value)}><option value="pickup">提箱</option><option value="dropoff">进场</option></select></label>
        <label>车牌号<input required value={String(editor.values.truckNo)} onChange={event => updateField('truckNo', event.target.value)}/></label><label>司机<input required value={String(editor.values.driver)} onChange={event => updateField('driver', event.target.value)}/></label>
        <label>窗口开始<input type="datetime-local" required value={String(editor.values.windowStart)} onChange={event => updateField('windowStart', event.target.value)}/></label><label>窗口结束<input type="datetime-local" required value={String(editor.values.windowEnd)} onChange={event => updateField('windowEnd', event.target.value)}/></label>
        <label>闸口车道<select value={String(editor.values.lane)} onChange={event => updateField('lane', event.target.value)}><option value="north">北闸口</option><option value="south">南闸口</option><option value="rail">铁路闸口</option></select></label>
      </div>}
      {editor.entity === 'task' && <div className="form-grid">
        <label>任务类型<select value={String(editor.values.kind)} onChange={event => updateField('kind', event.target.value)}>{['receive','deliver','rehandle','load','discharge','inspect'].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>关联箱号<select required value={String(editor.values.containerId)} onChange={event => updateField('containerId', event.target.value)}><option value="">选择箱号</option>{containers.map(container => <option key={container.id} value={container.id}>{container.id}</option>)}</select></label>
        <label>起点<input required value={String(editor.values.from)} onChange={event => updateField('from', event.target.value)}/></label><label>终点<input required value={String(editor.values.to)} onChange={event => updateField('to', event.target.value)}/></label>
        <label>优先级 (1–100)<input type="number" min="1" max="100" required value={String(editor.values.priority)} onChange={event => updateField('priority', event.target.value)}/></label><label>预计时长 (分钟)<input type="number" min="1" required value={String(editor.values.estimatedMinutes)} onChange={event => updateField('estimatedMinutes', event.target.value)}/></label>
        <label>计划时间<input type="datetime-local" required value={String(editor.values.scheduledAt)} onChange={event => updateField('scheduledAt', event.target.value)}/></label><label>指派设备<select value={String(editor.values.equipmentId)} onChange={event => updateField('equipmentId', event.target.value)}><option value="">暂不指派</option>{equipment.map(item => <option key={item.id} value={item.id}>{item.name} · {item.status}</option>)}</select></label>
        {editor.mode==='edit' && <label>任务状态<select value={String(editor.values.status)} onChange={event => updateField('status', event.target.value)}>{['queued','assigned','executing','blocked','done'].map(value => <option key={value} value={value}>{value}</option>)}</select></label>}
      </div>}
      {error && <div className="form-error">{error}</div>}<div className="modal-actions"><button type="button" onClick={() => setEditor(undefined)}>取消</button><button className="primary-action" disabled={busy}>{busy?'保存中…':'保存'}</button></div>
    </form></div>}
  </main>;
}
