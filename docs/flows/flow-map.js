// Flow map: every screen of a NobuRF flow on one canvas, the main path left to
// right and the edge cases branching above and below the screen they leave from.
// Data model and layout rules follow the flow-map view spec: nodes carry a
// state_type from a fixed vocabulary, edges carry a label and a trigger_kind.
// The layout is a pure function of flows.json, so the map never moves between runs.

const FRAME_WIDTH = 288;
const FRAME_HEIGHT = 180;
const STEP_LABEL_HEIGHT = 24;
const CAPTION_HEIGHT = 132;
const NODE_HEIGHT = STEP_LABEL_HEIGHT + FRAME_HEIGHT + CAPTION_HEIGHT;
const COLUMN_GAP = 168;
const ROW_GAP = 72;
const COLUMN_PITCH = FRAME_WIDTH + COLUMN_GAP;
const ROW_PITCH = NODE_HEIGHT + ROW_GAP;
const CANVAS_MARGIN = 96;
const TITLE_BLOCK_HEIGHT = 230;
const FIRST_GUTTER_OFFSET = 22;
const GUTTER_SPACING = 14;
const MIN_SCALE = 0.1;
const MAX_SCALE = 3;
const DRAG_THRESHOLD_PX = 4;
const SMALLEST_READABLE_FIT = 0.35;
const READABLE_START_SCALE = 0.6;
const WHEEL_ZOOM_STEP_LIMIT = 0.1;
const WHEEL_LINE_HEIGHT_PX = 16;

const STATE_GROUP = {
  happy: 'main', success: 'main', loading: 'main', pending: 'main', empty: 'main',
  offline: 'alternate', needs_approval: 'alternate', paused: 'alternate',
  slow: 'slow',
  error: 'error', rejected: 'error', failed: 'error',
};
const STATUS_TEXT = { captured: 'Captured', log: 'No screen: what the terminal or log shows', not_captured: 'Not captured yet', not_built: 'Not built yet' };
const TRIGGER_TEXT = { user_action: 'user action', system_event: 'system event', timer: 'timer', agent_decision: 'agent decision' };
const EDGE_DASH = { main: '', alternate: '', slow: '8 5', error: '3 4' };
const LEGEND = [
  ['main', 'Main path'],
  ['alternate', 'Alternate'],
  ['slow', 'Slow'],
  ['error', 'Error'],
];

const isExport = new URLSearchParams(location.search).has('export');
const world = document.getElementById('world');
const viewport = document.getElementById('viewport');
const zoomLevelOutput = document.getElementById('zoom-level');
const inspector = document.getElementById('inspector');

let flowsById = new Map();
let currentFlow = null;
let nodeElementsById = new Map();
let currentPlacements = new Map();
let edgeElements = [];
let worldSize = { width: 0, height: 0 };
let view = { x: 0, y: 0, scale: 1 };
let selectedNodeId = null;
let activeFilter = 'all';

const isSpine = (node) => /^\d+$/.test(node.id);
const columnOf = (node) => parseInt(node.id, 10) - 1;
const groupOf = (node) => STATE_GROUP[node.state_type];
const stateLabel = (stateType) => stateType[0].toUpperCase() + stateType.slice(1).replace('_', ' ');

function element(tag, attributes = {}, children = []) {
  const created = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === 'text') created.textContent = value;
    else created.setAttribute(name, value);
  }
  created.append(...children);
  return created;
}

function svgElement(tag, attributes = {}) {
  const created = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attributes)) created.setAttribute(name, value);
  return created;
}

// ---------------------------------------------------------------------------
// Validation: refuse to draw a map that would mislead (spec FR-1).

function validateFlows(data) {
  const problems = [];
  if (!Array.isArray(data.flows) || !Array.isArray(data.state_vocabulary)) {
    throw new Error('flows.json needs a flows array and a state_vocabulary array');
  }
  const vocabulary = new Set(data.state_vocabulary);
  const flowIds = new Set();
  const isText = (value) => typeof value === 'string' && value.trim() !== '';
  for (const flow of data.flows) {
    const where = (detail) => `${flow.id}: ${detail}`;
    if (flowIds.has(flow.id)) problems.push(where('duplicate flow id'));
    flowIds.add(flow.id);
    for (const field of ['id', 'name', 'description', 'provenance']) {
      if (!isText(flow[field])) problems.push(where(`flow needs a ${field}`));
    }
    const nodesById = new Map();
    for (const node of flow.nodes) {
      if (!/^\d+[a-z]?$/.test(node.id)) problems.push(where(`node id "${node.id}" must look like 3 or 3a`));
      if (nodesById.has(node.id)) problems.push(where(`duplicate node id ${node.id}`));
      nodesById.set(node.id, node);
      for (const field of ['title', 'summary', 'code_ref']) {
        if (!isText(node[field])) problems.push(where(`node ${node.id} needs a ${field}`));
      }
      if (!vocabulary.has(node.state_type) || !STATE_GROUP[node.state_type]) problems.push(where(`node ${node.id} has unknown state_type "${node.state_type}"`));
      if (!STATUS_TEXT[node.status]) problems.push(where(`node ${node.id} has unknown status "${node.status}"`));
      if ((node.status === 'captured') !== Boolean(node.screen)) problems.push(where(`node ${node.id}: a screen is required exactly when status is captured`));
      if ((node.status === 'log') !== isText(node.log)) problems.push(where(`node ${node.id}: log text is required exactly when status is log`));
      if (node.place !== undefined && node.place !== 'above') problems.push(where(`node ${node.id}: place can only be "above"`));
      if (node.place !== undefined && isSpine(node)) problems.push(where(`node ${node.id}: main-path nodes cannot be placed`));
    }
    const spineColumns = flow.nodes.filter(isSpine).map(columnOf).sort((a, b) => a - b);
    spineColumns.forEach((column, index) => {
      if (column !== index) problems.push(where(`main path must be numbered 1, 2, 3… without gaps (found ${column + 1})`));
    });
    const nodesWithIncomingEdge = new Set();
    for (const edge of flow.edges) {
      const from = nodesById.get(edge.from);
      const to = nodesById.get(edge.to);
      if (!from || !to) {
        problems.push(where(`edge ${edge.from} → ${edge.to} points at a missing node`));
        continue;
      }
      nodesWithIncomingEdge.add(edge.to);
      if (!isText(edge.label)) problems.push(where(`edge ${edge.from} → ${edge.to} needs a label`));
      if (!TRIGGER_TEXT[edge.trigger_kind]) problems.push(where(`edge ${edge.from} → ${edge.to} has unknown trigger_kind "${edge.trigger_kind}"`));
      const isNextOnSpine = isSpine(from) && isSpine(to) && columnOf(to) === columnOf(from) + 1;
      const isSameColumn = columnOf(from) === columnOf(to);
      if (!isNextOnSpine && !isSameColumn) problems.push(where(`edge ${edge.from} → ${edge.to} must go to the next main-path screen or stay in its column`));
    }
    for (const node of flow.nodes) {
      if (node.id !== '1' && !nodesWithIncomingEdge.has(node.id)) problems.push(where(`node ${node.id} has no incoming edge`));
    }
  }
  if (problems.length) throw new Error(`flows.json has ${problems.length} problem(s):\n${problems.join('\n')}`);
}

// ---------------------------------------------------------------------------
// Layout (spec FR-2): main path left to right, branches stacked above or below
// their column in id order, so 3a sits nearest to 3.

function layoutFlow(flow) {
  const sortedNodes = [...flow.nodes].sort((a, b) => columnOf(a) - columnOf(b) || a.id.localeCompare(b.id));
  const branchDepthByColumnAndSide = new Map();
  const placements = new Map();
  for (const node of sortedNodes) {
    let row = 0;
    if (!isSpine(node)) {
      const side = node.place === 'above' ? -1 : 1;
      const key = `${columnOf(node)}:${side}`;
      const depth = (branchDepthByColumnAndSide.get(key) ?? 0) + 1;
      branchDepthByColumnAndSide.set(key, depth);
      row = depth * side;
    }
    placements.set(node.id, { node, column: columnOf(node), row });
  }
  const rows = [...placements.values()].map((placement) => placement.row);
  const topRow = Math.min(...rows);
  const bottomRow = Math.max(...rows);
  const columnCount = Math.max(...[...placements.values()].map((placement) => placement.column)) + 1;
  for (const placement of placements.values()) {
    placement.x = CANVAS_MARGIN + placement.column * COLUMN_PITCH;
    placement.y = CANVAS_MARGIN + TITLE_BLOCK_HEIGHT + (placement.row - topRow) * ROW_PITCH;
  }
  return {
    placements,
    width: CANVAS_MARGIN * 2 + columnCount * COLUMN_PITCH - COLUMN_GAP,
    height: CANVAS_MARGIN * 2 + TITLE_BLOCK_HEIGHT + (bottomRow - topRow + 1) * ROW_PITCH - ROW_GAP,
  };
}

function routeEdge(from, to, gutterIndex) {
  const frameMiddle = (placement) => placement.y + STEP_LABEL_HEIGHT + FRAME_HEIGHT / 2;
  if (from.column !== to.column) {
    const startX = from.x + FRAME_WIDTH;
    const y = frameMiddle(from);
    return { path: `M${startX} ${y}H${to.x - 2}`, labelX: (startX + to.x) / 2, labelY: y, kind: 'spine' };
  }
  const goesDown = to.row > from.row;
  const frameRight = from.x + FRAME_WIDTH;
  const gutterX = frameRight + FIRST_GUTTER_OFFSET + gutterIndex * GUTTER_SPACING;
  const startY = from.y + STEP_LABEL_HEIGHT + FRAME_HEIGHT * (goesDown ? 0.7 : 0.3);
  // The label sits in the gap next to the target, left of the line, so stacked
  // branches in the same gutter never draw through each other's labels.
  const labelY = goesDown ? to.y - ROW_GAP / 2 : to.y + NODE_HEIGHT + ROW_GAP / 2;
  return { path: `M${frameRight} ${startY}H${gutterX}V${frameMiddle(to)}H${frameRight + 2}`, labelX: gutterX - 8, labelY, kind: 'branch' };
}

// ---------------------------------------------------------------------------
// Rendering

function renderTitleBlock(flow) {
  const findingCount = flow.nodes.filter((node) => node.finding).length;
  const gapCount = flow.nodes.filter((node) => node.status === 'not_captured' || node.status === 'not_built').length;
  const legend = element('ul', { class: 'legend', 'aria-label': 'Line styles' });
  for (const [group, label] of LEGEND) {
    const sample = svgElement('svg', { width: 28, height: 8, 'aria-hidden': 'true', 'data-group': group });
    sample.append(svgElement('path', { d: 'M1 4H27', stroke: 'var(--group-color)', 'stroke-width': 2, 'stroke-dasharray': EDGE_DASH[group] }));
    legend.append(element('li', {}, [sample, label]));
  }
  return element('section', { class: 'title-block', style: `left:${CANVAS_MARGIN}px;top:${CANVAS_MARGIN}px` }, [
    element('h1', { text: `NobuRF · ${flow.name}` }),
    element('p', { class: 'description', text: flow.description }),
    element('p', { class: 'provenance', text: flow.provenance }),
    legend,
    element('p', {
      class: 'counts',
      text: `${flow.nodes.length} screens and states · ${gapCount} not captured or built yet · ${findingCount} findings`,
    }),
  ]);
}

function renderNode(node, placement) {
  const group = groupOf(node);
  const frame = node.status === 'captured'
    ? element('span', { class: 'frame' }, [element('img', { src: node.screen, alt: '', width: FRAME_WIDTH, height: FRAME_HEIGHT, decoding: 'async' })])
    : node.status === 'log'
      ? element('span', { class: 'frame log', text: node.log })
      : element('span', { class: 'frame gap', text: STATUS_TEXT[node.status] });
  const tags = element('span', { class: 'tags' }, [element('span', { class: 'badge', text: stateLabel(node.state_type) })]);
  if (node.finding) tags.append(element('span', { class: 'finding-tag', text: 'Finding' }));
  const accessibleName = [`${node.id}, ${node.title}`, stateLabel(node.state_type), STATUS_TEXT[node.status], node.finding ? 'Has a finding' : '']
    .filter(Boolean)
    .join('. ');
  const button = element('button', {
    type: 'button',
    class: 'node',
    'data-group': group,
    'data-node-id': node.id,
    'aria-label': accessibleName,
    style: `left:${placement.x}px;top:${placement.y}px`,
  }, [
    element('span', { class: 'step' }, [element('span', { class: 'id', text: `${node.id} · ` }), node.title]),
    frame,
    element('span', { class: 'caption' }, [tags, element('span', { class: 'summary', text: node.summary })]),
  ]);
  button.addEventListener('click', () => setRoute(currentFlow.id, node.id));
  button.addEventListener('focus', () => {
    if (button.matches(':focus-visible')) bringIntoView(placement);
  });
  return button;
}

function renderFlow(flow) {
  currentFlow = flow;
  const layout = layoutFlow(flow);
  worldSize = { width: layout.width, height: layout.height };
  currentPlacements = layout.placements;
  world.replaceChildren();
  world.style.width = `${layout.width}px`;
  world.style.height = `${layout.height}px`;
  nodeElementsById = new Map();
  edgeElements = [];

  const edgeLayer = svgElement('svg', { class: 'edges', width: layout.width, height: layout.height, 'aria-hidden': 'true' });
  const definitions = svgElement('defs');
  for (const [group] of LEGEND) {
    const marker = svgElement('marker', { id: `arrow-${group}`, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 8, markerHeight: 8, orient: 'auto-start-reverse', 'data-group': group });
    marker.append(svgElement('path', { d: 'M0 0.5L8 4L0 7.5z', fill: 'var(--group-color)' }));
    definitions.append(marker);
  }
  edgeLayer.append(definitions);
  world.append(edgeLayer, renderTitleBlock(flow));

  const nodesById = new Map(flow.nodes.map((node) => [node.id, node]));
  const gutterIndexByEdge = assignGutters(flow, layout.placements);
  for (const edge of flow.edges) {
    const from = layout.placements.get(edge.from);
    const to = layout.placements.get(edge.to);
    const group = groupOf(nodesById.get(edge.to));
    const route = routeEdge(from, to, gutterIndexByEdge.get(edge));
    const path = svgElement('path', {
      d: route.path,
      'data-group': group,
      stroke: 'var(--group-color)',
      'stroke-dasharray': EDGE_DASH[group],
      'marker-end': `url(#arrow-${group})`,
    });
    edgeLayer.append(path);
    const label = element('span', {
      class: `edge-label ${route.kind}`,
      'data-group': group,
      style: `left:${route.labelX}px;top:${route.labelY}px`,
      text: edge.label,
    });
    world.append(label);
    edgeElements.push({ edge, path, label });
  }

  for (const node of flow.nodes) {
    const nodeElement = renderNode(node, layout.placements.get(node.id));
    nodeElementsById.set(node.id, nodeElement);
    world.append(nodeElement);
  }
  applyFilter(activeFilter);
}

// Branches leaving the same screen on the same side get their own gutter
// line, nearest target innermost, so the lines run side by side without crossing.
function assignGutters(flow, placements) {
  const edgesBySourceAndSide = new Map();
  for (const edge of flow.edges) {
    const from = placements.get(edge.from);
    const to = placements.get(edge.to);
    if (from.column !== to.column) continue;
    const key = `${edge.from}:${Math.sign(to.row - from.row)}`;
    if (!edgesBySourceAndSide.has(key)) edgesBySourceAndSide.set(key, []);
    edgesBySourceAndSide.get(key).push(edge);
  }
  const gutterIndexByEdge = new Map();
  for (const edges of edgesBySourceAndSide.values()) {
    const distance = (edge) => Math.abs(placements.get(edge.to).row - placements.get(edge.from).row);
    edges.sort((a, b) => distance(a) - distance(b)).forEach((edge, index) => gutterIndexByEdge.set(edge, index));
  }
  return gutterIndexByEdge;
}

// ---------------------------------------------------------------------------
// Filters (spec FR-4): dim what does not match, but keep the screen each
// highlighted branch leaves from, so nothing looks orphaned.

function nodeMatchesFilter(node, filter) {
  if (filter === 'all') return true;
  if (filter === 'finding') return Boolean(node.finding);
  if (filter === 'gap') return node.status === 'not_captured' || node.status === 'not_built';
  return groupOf(node) === filter;
}

function applyFilter(filter) {
  activeFilter = filter;
  for (const button of document.querySelectorAll('[data-filter]')) {
    button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
  }
  const highlightedIds = new Set(currentFlow.nodes.filter((node) => nodeMatchesFilter(node, filter)).map((node) => node.id));
  const contextIds = new Set(currentFlow.edges.filter((edge) => highlightedIds.has(edge.to)).map((edge) => edge.from));
  for (const [nodeId, nodeElement] of nodeElementsById) {
    nodeElement.classList.toggle('dimmed', !highlightedIds.has(nodeId) && !contextIds.has(nodeId) && nodeId !== selectedNodeId);
  }
  for (const { edge, path, label } of edgeElements) {
    const dimmed = !highlightedIds.has(edge.to);
    path.classList.toggle('dimmed', dimmed);
    label.classList.toggle('dimmed', dimmed);
  }
}

// ---------------------------------------------------------------------------
// Inspector (spec FR-5, node level)

function openInspector(nodeId) {
  const node = currentFlow.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`no node ${nodeId} in flow ${currentFlow.id}`);
  nodeElementsById.get(selectedNodeId)?.classList.remove('selected');
  selectedNodeId = nodeId;
  nodeElementsById.get(nodeId).classList.add('selected');

  const shotLink = document.getElementById('inspector-shot');
  const gapNote = document.getElementById('inspector-gap');
  shotLink.hidden = node.status !== 'captured';
  gapNote.hidden = node.status === 'captured';
  if (node.status === 'captured') {
    shotLink.href = node.screen;
    shotLink.setAttribute('aria-label', `Open the ${node.title} screenshot at full size`);
    shotLink.querySelector('img').src = node.screen;
  } else {
    gapNote.textContent = node.status === 'log' ? node.log : STATUS_TEXT[node.status];
  }
  gapNote.classList.toggle('log', node.status === 'log');
  const title = document.getElementById('inspector-title');
  title.textContent = `${node.id} · ${node.title}`;
  const state = document.getElementById('inspector-state');
  state.textContent = stateLabel(node.state_type);
  state.dataset.group = groupOf(node);
  document.getElementById('inspector-status').textContent = STATUS_TEXT[node.status];
  document.getElementById('inspector-summary').textContent = node.summary;
  const finding = document.getElementById('inspector-finding');
  finding.hidden = !node.finding;
  finding.querySelector('p').textContent = node.finding ?? '';
  document.getElementById('inspector-code').textContent = node.code_ref;

  const nodesById = new Map(currentFlow.nodes.map((candidate) => [candidate.id, candidate]));
  const transitionItems = [];
  for (const edge of currentFlow.edges) {
    const isIncoming = edge.to === nodeId;
    if (!isIncoming && edge.from !== nodeId) continue;
    const otherNode = nodesById.get(isIncoming ? edge.from : edge.to);
    const jump = element('button', { type: 'button', text: `${otherNode.id} · ${otherNode.title}` });
    jump.addEventListener('click', () => setRoute(currentFlow.id, otherNode.id));
    const condition = edge.condition ? `, when ${edge.condition}` : '';
    transitionItems.push(element('li', {}, [isIncoming ? 'From ' : 'To ', jump, `: “${edge.label}” (${TRIGGER_TEXT[edge.trigger_kind]})${condition}`]));
  }
  document.getElementById('inspector-edges').replaceChildren(...transitionItems);

  inspector.hidden = false;
  bringIntoView(currentPlacements.get(nodeId));
  title.tabIndex = -1;
  title.focus({ preventScroll: true });
}

function closeInspector() {
  if (inspector.hidden) return;
  inspector.hidden = true;
  const nodeElement = nodeElementsById.get(selectedNodeId);
  nodeElement?.classList.remove('selected');
  selectedNodeId = null;
  nodeElement?.focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------
// Pan and zoom

function applyView({ animate = false } = {}) {
  world.classList.toggle('animate', animate);
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  zoomLevelOutput.textContent = `${Math.round(view.scale * 100)}%`;
}

function visibleArea() {
  const toolbarBottom = document.querySelector('.toolbar').getBoundingClientRect().bottom;
  const top = toolbarBottom + 12;
  return { left: 0, top, width: innerWidth, height: innerHeight - top };
}

function fitToScreen({ animate = false } = {}) {
  const area = visibleArea();
  const scale = Math.min((area.width - 32) / worldSize.width, (area.height - 16) / worldSize.height, 1);
  view = {
    scale,
    x: (area.width - worldSize.width * scale) / 2,
    y: area.top + (area.height - worldSize.height * scale) / 2,
  };
  applyView({ animate });
}

// Fit when the whole map stays legible; on small screens start at a readable
// scale on the title and the first screens instead, and leave Fit to the button.
function showStartView() {
  fitToScreen();
  if (view.scale >= SMALLEST_READABLE_FIT) return;
  const area = visibleArea();
  const worldInset = (CANVAS_MARGIN - 24) * READABLE_START_SCALE;
  view = { scale: READABLE_START_SCALE, x: 16 - worldInset, y: area.top - worldInset };
  applyView();
}

function zoomAround(screenX, screenY, factor, { animate = false } = {}) {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
  const ratio = scale / view.scale;
  view = { scale, x: screenX - (screenX - view.x) * ratio, y: screenY - (screenY - view.y) * ratio };
  applyView({ animate });
}

function zoomAroundCenter(factor) {
  const area = visibleArea();
  zoomAround(area.width / 2, area.top + area.height / 2, factor, { animate: true });
}

function bringIntoView(placement) {
  const area = visibleArea();
  const nodeLeft = view.x + placement.x * view.scale;
  const nodeTop = view.y + placement.y * view.scale;
  const nodeRight = nodeLeft + FRAME_WIDTH * view.scale;
  const nodeBottom = nodeTop + NODE_HEIGHT * view.scale;
  const inspectorWidth = inspector.hidden || innerWidth <= 720 ? 0 : inspector.offsetWidth + 24;
  const fullyVisible = nodeLeft >= 16 && nodeTop >= area.top && nodeRight <= area.width - inspectorWidth - 16 && nodeBottom <= innerHeight - 16;
  if (fullyVisible) return;
  view.x = (area.width - inspectorWidth) / 2 - (placement.x + FRAME_WIDTH / 2) * view.scale;
  view.y = area.top + area.height / 2 - (placement.y + NODE_HEIGHT / 2) * view.scale;
  applyView({ animate: true });
}

const pointerState = { pointers: new Map(), dragging: false, suppressNextClick: false, pinchDistance: 0, pinchMiddle: null };

function pinchGeometry() {
  const [first, second] = [...pointerState.pointers.values()];
  return {
    distance: Math.hypot(second.x - first.x, second.y - first.y),
    middle: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
  };
}

function wirePointerControls() {
  viewport.addEventListener('pointerdown', (event) => {
    pointerState.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY });
    pointerState.suppressNextClick = false;
    if (pointerState.pointers.size === 2) {
      const { distance, middle } = pinchGeometry();
      pointerState.pinchDistance = distance;
      pointerState.pinchMiddle = middle;
    }
  });
  viewport.addEventListener('pointermove', (event) => {
    const pointer = pointerState.pointers.get(event.pointerId);
    if (!pointer) return;
    const deltaX = event.clientX - pointer.x;
    const deltaY = event.clientY - pointer.y;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    if (pointerState.pointers.size === 2) {
      const { distance, middle } = pinchGeometry();
      view.x += middle.x - pointerState.pinchMiddle.x;
      view.y += middle.y - pointerState.pinchMiddle.y;
      zoomAround(middle.x, middle.y, distance / pointerState.pinchDistance);
      pointerState.pinchDistance = distance;
      pointerState.pinchMiddle = middle;
      pointerState.dragging = true;
      return;
    }
    if (!pointerState.dragging) {
      if (Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) < DRAG_THRESHOLD_PX) return;
      pointerState.dragging = true;
      viewport.setPointerCapture(event.pointerId);
      viewport.classList.add('dragging');
    }
    view.x += deltaX;
    view.y += deltaY;
    applyView();
  });
  const endPointer = (event) => {
    pointerState.pointers.delete(event.pointerId);
    if (pointerState.pointers.size > 0) return;
    if (pointerState.dragging) pointerState.suppressNextClick = true;
    pointerState.dragging = false;
    viewport.classList.remove('dragging');
  };
  viewport.addEventListener('pointerup', endPointer);
  // The click that ends a drag must not open a node. Catch it before it reaches
  // one. Keyboard clicks (detail 0) always go through.
  viewport.addEventListener('click', (event) => {
    if (!pointerState.suppressNextClick) return;
    pointerState.suppressNextClick = false;
    if (event.detail !== 0) event.stopPropagation();
  }, { capture: true });
  viewport.addEventListener('pointercancel', endPointer);

  // Scroll pans, as in design tools; Control or Command with scroll (and trackpad pinch) zooms.
  viewport.addEventListener('wheel', (event) => {
    event.preventDefault();
    const pixelsPerUnit = { 0: 1, 1: WHEEL_LINE_HEIGHT_PX, 2: innerHeight }[event.deltaMode];
    const deltaX = event.deltaX * pixelsPerUnit;
    const deltaY = event.deltaY * pixelsPerUnit;
    if (event.ctrlKey || event.metaKey) {
      const zoomStep = Math.max(-WHEEL_ZOOM_STEP_LIMIT, Math.min(WHEEL_ZOOM_STEP_LIMIT, -deltaY * 0.01));
      zoomAround(event.clientX, event.clientY, Math.exp(zoomStep));
    } else {
      view.x -= deltaX;
      view.y -= deltaY;
      applyView();
    }
  }, { passive: false });
}

function wireKeyboardControls() {
  const panStepPx = 80;
  addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const panByKey = { ArrowLeft: [panStepPx, 0], ArrowRight: [-panStepPx, 0], ArrowUp: [0, panStepPx], ArrowDown: [0, -panStepPx] };
    if (event.key === 'Escape' && !inspector.hidden) setRoute(currentFlow.id);
    else if (event.key === '+' || event.key === '=') zoomAroundCenter(1.25);
    else if (event.key === '-') zoomAroundCenter(0.8);
    else if (event.key === '0') fitToScreen({ animate: true });
    else if (panByKey[event.key] && !event.target.closest('#inspector')) {
      view.x += panByKey[event.key][0];
      view.y += panByKey[event.key][1];
      applyView({ animate: true });
    } else return;
    event.preventDefault();
  });
}

function wireToolbar() {
  for (const button of document.querySelectorAll('[data-filter]')) {
    button.addEventListener('click', () => applyFilter(button.dataset.filter));
  }
  document.querySelector('[data-zoom="in"]').addEventListener('click', () => zoomAroundCenter(1.25));
  document.querySelector('[data-zoom="out"]').addEventListener('click', () => zoomAroundCenter(0.8));
  document.querySelector('[data-zoom="fit"]').addEventListener('click', () => fitToScreen({ animate: true }));
  inspector.querySelector('.close').addEventListener('click', () => setRoute(currentFlow.id));
}

// ---------------------------------------------------------------------------
// Routing: #solver, #race, #race/4b

function setRoute(flowId, nodeId) {
  location.hash = nodeId ? `${flowId}/${nodeId}` : flowId;
}

function showRoute() {
  document.querySelector('.fatal')?.remove();
  const [requestedFlowId, nodeId] = location.hash.slice(1).split('/');
  const flow = requestedFlowId ? flowsById.get(requestedFlowId) : flowsById.values().next().value;
  if (!flow) {
    showFatalError(`There is no flow called “${requestedFlowId}”. Try ${[...flowsById.keys()].map((id) => `#${id}`).join(' or ')}.`);
    return;
  }
  if (flow !== currentFlow) {
    closeInspector();
    renderFlow(flow);
    showStartView();
    for (const link of document.querySelectorAll('[data-flow-link]')) {
      if (link.dataset.flowLink === flow.id) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    document.title = `NobuRF flow maps · ${flow.name}`;
  }
  if (!nodeId) closeInspector();
  else if (flow.nodes.some((node) => node.id === nodeId)) openInspector(nodeId);
  else showFatalError(`${flow.name} has no screen “${nodeId}”.`);
}

function showFatalError(message) {
  document.body.append(element('p', { class: 'fatal', role: 'alert', text: message }));
}

async function renderForExport(flow) {
  document.documentElement.classList.add('export');
  renderFlow(flow);
  document.body.style.width = `${worldSize.width}px`;
  document.body.style.height = `${worldSize.height}px`;
  await Promise.all([...world.querySelectorAll('img')].map((image) => image.decode()));
  document.body.dataset.exportReady = 'true';
}

async function start() {
  const response = await fetch('flows.json');
  if (!response.ok) throw new Error(`Could not load flows.json (HTTP ${response.status}).`);
  const data = await response.json();
  validateFlows(data);
  flowsById = new Map(data.flows.map((flow) => [flow.id, flow]));
  if (isExport) {
    const flowId = new URLSearchParams(location.search).get('export');
    const flow = flowsById.get(flowId);
    if (!flow) throw new Error(`?export=${flowId} names no flow (known: ${[...flowsById.keys()].join(', ')})`);
    await renderForExport(flow);
    return;
  }
  wireToolbar();
  wirePointerControls();
  wireKeyboardControls();
  addEventListener('hashchange', showRoute);
  showRoute();
}

start().catch((error) => {
  const servedFromDisk = location.protocol === 'file:';
  showFatalError(servedFromDisk
    ? 'Open this page through a web server, not from disk. From the repo root: npx serve docs/flows'
    : error.message);
  throw error;
});
