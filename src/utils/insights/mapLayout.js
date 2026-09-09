const DAY = 86400000;
const addressOrder = (a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
const hashAngle = address => {
  let hash = 2166136261;
  for (const char of address) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) / 4294967296 * Math.PI * 2;
};

/** Deterministic, bounded layout. Crowded nodes stay in the equivalent list;
 * angular placement never changes the recency radius to make room. */
export function layoutSenderMap(senders, { width, height, endAt, limit = 30 }) {
  width = Math.max(0, Number(width) || 0);
  height = Math.max(0, Number(height) || 0);
  const center = { x: width / 2, y: height / 2 };
  const bounds = { width, height };
  const end = typeof endAt === 'number' ? endAt : Date.parse(endAt);
  const eligible = senders.filter(s => s.count > 0 && Number.isFinite(s.count)
    && s.lastAt != null && Number.isFinite(Date.parse(s.lastAt)))
    .sort((a, b) => b.count - a.count || Date.parse(b.lastAt) - Date.parse(a.lastAt) || addressOrder(a, b));
  const candidates = eligible.slice(0, Math.max(0, Math.min(30, limit)));
  if (!candidates.length || !Number.isFinite(end) || Math.min(width, height) < 160) {
    return { nodes: [], center, bounds, omittedCount: senders.length };
  }
  const largestRadius = Math.min(32, Math.min(width, height) / 12);
  const scale = largestRadius / Math.sqrt(candidates[0].count);
  const minDistance = largestRadius + 36;
  const maxDistance = Math.min(width, height) / 2 - largestRadius - 16;
  const oldestDays = Math.max(1, ...eligible.map(s => Math.max(0, (end - Date.parse(s.lastAt)) / DAY)));
  const nodes = [];
  for (const sender of candidates) {
    const radius = scale * Math.sqrt(sender.count);
    const hitRadius = Math.max(12, radius);
    const ageDays = Math.max(0, (end - Date.parse(sender.lastAt)) / DAY);
    const radialDistance = minDistance + (maxDistance - minDistance) * Math.log1p(ageDays) / Math.log1p(oldestDays);
    const initialAngle = hashAngle(sender.address);
    for (let pass = 0; pass < 24; pass++) {
      const angle = initialAngle + pass * Math.PI * (3 - Math.sqrt(5));
      const x = center.x + Math.cos(angle) * radialDistance;
      const y = center.y + Math.sin(angle) * radialDistance;
      if (x - hitRadius < 0 || y - hitRadius < 0 || x + hitRadius > width || y + hitRadius > height) continue;
      if (nodes.some(n => Math.hypot(x - n.x, y - n.y) < hitRadius + Math.max(12, n.radius) + 4)) continue;
      nodes.push({ address: sender.address, x, y, radius, radialDistance });
      break;
    }
  }
  return { nodes, center, bounds, omittedCount: senders.length - nodes.length };
}
