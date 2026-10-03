import test from 'node:test'; import assert from 'node:assert/strict'; import { blockDetail, containerPlan, dashboard, gateConflicts, prioritizeTasks } from './domain.js';
test('dashboard aggregates berth, yard, gate and exception signals', () => { const data = dashboard(); assert.equal(data.activeVoyages, 2); assert.ok(data.yardUtilization > 0.7); assert.ok(data.blockedTasks >= 1); });
test('gate conflict engine detects same truck overlap', () => { const conflicts = gateConflicts(); assert.ok(conflicts.some(item => item.appointmentId === 'APT-9001' || item.appointmentId === 'APT-9004')); });
test('yard planner respects reefer and hazmat constraints', () => { const plan = containerPlan('TGHU-9831204'); assert.equal(plan?.recommendedBlock?.hazmatAllowed, true); assert.ok(plan?.reasons.some(reason => reason.includes('危险品'))); });
test('priority queue promotes customs inspection work', () => { const tasks = prioritizeTasks(); assert.equal(tasks[0].containerId, 'TGHU-9831204'); });

test('block detail aggregates containers, pending tasks, equipment and inspection advice', () => {
  const detail = blockDetail('D05');
  assert.ok(detail);
  assert.ok(detail.containers.some(item => item.id === 'TGHU-9831204'));
  assert.ok(detail.stats.hazmatCount >= 1 && detail.stats.customsHeld >= 1);
  assert.ok(detail.pendingTasks.some(item => item.id === 'TASK-103'));
  assert.ok(detail.equipment.some(item => item.id === 'RS-02'));
  assert.ok(detail.advice.some(item => item.text.includes('查验')));
  assert.equal(blockDetail('Z99'), undefined);
});

test('block detail flags full blocks with critical disposal advice', async () => {
  const { blocks } = await import('./domain.js');
  blocks.push({ id: 'T99', zone: 'Test Overflow', rows: 2, tiers: 2, capacity: 10, occupied: 10, reeferPlugs: 0, usedPlugs: 0, hazmatAllowed: false, equipment: [], heat: 40 });
  const detail = blockDetail('T99');
  blocks.splice(blocks.findIndex(item => item.id === 'T99'), 1);
  assert.ok(detail?.advice.some(item => item.tone === 'critical' && item.text.includes('满载')));
});

test('container create, update and delete form a complete audited CRUD cycle', async () => {
  const { createContainer, updateContainer, deleteContainer, containers } = await import('./domain.js');
  const created = createContainer({ id: 'TEST-CRUD-0001', voyageId: 'VOY-AX7', size: '20', isoType: '22G1', direction: 'import', status: 'in-yard', weightT: 10, reefer: false, customs: 'released', priority: 'normal', yardSlot: 'C03-R11-T1' });
  assert.equal(created.id, 'TEST-CRUD-0001');
  assert.equal(updateContainer(created.id, { weightT: 12 })?.weightT, 12);
  assert.equal(deleteContainer(created.id)?.id, 'TEST-CRUD-0001');
  assert.equal(containers.some(item => item.id === 'TEST-CRUD-0001'), false);
});

test('appointment and task domain operations support create, update and delete', async () => {
  const { createGateAppointment, editGateAppointment, deleteGateAppointment, createYardTask, updateYardTask, deleteYardTask } = await import('./domain.js');
  const appointment = createGateAppointment({ containerId: 'MSCU-4829017', truckNo: 'TEST-CRUD-01', driver: '测试司机', type: 'pickup', windowStart: new Date(Date.now()+3600000).toISOString(), windowEnd: new Date(Date.now()+7200000).toISOString(), lane: 'north' });
  assert.equal(editGateAppointment(appointment.id, { driver: '更新司机' })?.driver, '更新司机');
  assert.equal(deleteGateAppointment(appointment.id)?.id, appointment.id);
  const task = createYardTask({ kind: 'deliver', containerId: 'MSCU-4829017', from: 'A01-R01-T1', to: '南闸口', priority: 40, scheduledAt: new Date().toISOString(), estimatedMinutes: 12 });
  assert.equal(updateYardTask(task.id, { to: '北闸口' })?.to, '北闸口');
  assert.equal(deleteYardTask(task.id)?.id, task.id);
});
