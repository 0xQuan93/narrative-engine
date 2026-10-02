import test from 'node:test';
import assert from 'node:assert/strict';
import {stableDrawOrder} from '../src/render/draw-order.mjs';

test('draw sorting ignores asynchronous object/material allocation IDs', () => {
  const sort = (ids) => {
    const nodes = ids.map((id, i) => ({id, name: String(i), material: {id: ids[ids.length - 1 - i]}}));
    const order = stableDrawOrder({traverse: (visit) => nodes.forEach(visit)});
    const items = nodes.map((object) => ({object, material: object.material, id: object.id, groupOrder: 0, renderOrder: 0, z: 1}));
    return [...items].reverse().sort(order.opaque).map((item) => item.object.name);
  };
  assert.deepEqual(sort([200, 3, 89]), sort([4, 150, 1]));
});
test('transparent sorting keeps back-to-front depth and authored render order', () => {
  const nodes = [{material: {}}, {material: {}}];
  const order = stableDrawOrder({traverse: (visit) => nodes.forEach(visit)});
  const items = nodes.map((object, i) => ({object, material: object.material, groupOrder: 0, renderOrder: 0, z: i + 1}));
  assert.equal([...items].sort(order.transparent)[0], items[1]);
  items[0].renderOrder = -1;
  assert.equal([...items].sort(order.transparent)[0], items[0]);
});
