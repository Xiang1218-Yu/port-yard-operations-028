import test from 'node:test'; import assert from 'node:assert/strict'; import { blockDetail, blocks, containerPlan, dashboard, gateConflicts, prioritizeTasks } from './domain.js';
test('dashboard aggregates berth, yard, gate and exception signals', () => { const data = dashboard(); assert.equal(data.activeVoyages, 2); assert.ok(data.yardUtilization > 0.7); assert.ok(data.blockedTasks >= 1); });
test('gate conflict engine detects same truck overlap', () => { const conflicts = gateConflicts(); assert.ok(conflicts.some(item => item.appointmentId === 'APT-9001' || item.appointmentId === 'APT-9004')); });
test('yard planner respects reefer and hazmat constraints', () => { const plan = containerPlan('TGHU-9831204'); assert.equal(plan?.recommendedBlock?.hazmatAllowed, true); assert.ok(plan?.reasons.some(reason => reason.includes('危险品'))); });
test('priority queue promotes customs inspection work', () => { const tasks = prioritizeTasks(); assert.equal(tasks[0].containerId, 'TGHU-9831204'); });

test('block detail aggregates containers, open tasks and accessible equipment', () => {
  const detail = blockDetail('B07');
  assert.ok(detail);
  assert.equal(detail!.block.id, 'B07');
  assert.ok(detail!.containers.some(c => c.id === 'EISU-1288420'));
  assert.ok(detail!.reefer.reeferContainers.some(c => c.id === 'EISU-1288420'));
  assert.equal(detail!.reefer.plugsFree, detail!.reefer.plugsTotal - detail!.reefer.plugsUsed);
  assert.ok(detail!.openTasks.some(t => t.id === 'TASK-102'));
  assert.ok(!detail!.openTasks.some(t => t.status === 'done'));
  assert.ok(detail!.equipment.some(e => e.id === 'YC-12'));
  assert.ok(detail!.availableCount >= 0);
});

test('inspection zone surfaces inspection-specific advisory', () => {
  const detail = blockDetail('D05');
  assert.ok(detail);
  assert.equal(detail!.advisory.tone, 'inspection');
  assert.match(detail!.advisory.title, /查验/);
  assert.ok(detail!.hazmat.hazmatContainers.some(c => c.id === 'TGHU-9831204'));
  assert.ok(detail!.hazmat.heldCount >= 1);
  assert.ok(detail!.advisory.reasons.some(reason => reason.includes('正面吊')));
});

test('missing block returns undefined so the API can return an explicit empty state', () => {
  assert.equal(blockDetail('Z99'), undefined);
});

test('full block triggers the stop-intake advisory and points to an alternative', () => {
  const target = blocks.find(b => b.id === 'A01')!;
  const originalOccupied = target.occupied;
  target.occupied = target.capacity;
  try {
    const detail = blockDetail('A01');
    assert.equal(detail!.advisory.tone, 'full');
    assert.ok(detail!.advisory.reasons.some(reason => reason.includes('满载')));
    assert.ok(detail!.advisory.reasons.some(reason => reason.includes('C03')));
  } finally {
    target.occupied = originalOccupied;
  }
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
