/**
 * Renderer — вся отрисовка на canvas.
 * Узлы, связи, частицы, временная линия при создании связи.
 */
export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;
    /** @type {CanvasImageSource | null} */
    this._gridCache = null;
    this.resize();
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.canvas.width = rect.width * this.dpr;
    this.canvas.height = rect.height * this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.width = rect.width;
    this.height = rect.height;
    // Invalidate grid cache on resize
    this._gridCache = null;
  }

  clear() {
    const ctx = this.ctx;
    // Draw cached grid instead of redrawing every frame
    if (!this._gridCache) {
      this._buildGridCache();
    }
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.drawImage(this._gridCache, 0, 0);
  }

  /** Build grid into an offscreen canvas once and cache it */
  _buildGridCache() {
    const off = document.createElement('canvas');
    off.width = this.width * this.dpr;
    off.height = this.height * this.dpr;
    const ctx = off.getContext('2d');
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const step = 40;
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = step; x < this.width; x += step) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.height);
    }
    for (let y = step; y < this.height; y += step) {
      ctx.moveTo(0, y);
      ctx.lineTo(this.width, y);
    }
    ctx.stroke();
    this._gridCache = off;
  }

  /** Нарисовать все связи */
  drawConnections(connections) {
    const ctx = this.ctx;
    for (const conn of connections) {
      const from = conn.from.node;
      const to = conn.to.node;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      ctx.strokeStyle = '#4a5568';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();

      // Стрелка
      if (dist > 10) {
        const angle = Math.atan2(dy, dx);
        const arrowSize = 10;
        const arrowX = to.x - Math.cos(angle) * (to.height / 2 + 4);
        const arrowY = to.y - Math.sin(angle) * (to.height / 2 + 4);
        ctx.fillStyle = '#4a5568';
        ctx.beginPath();
        ctx.moveTo(arrowX, arrowY);
        ctx.lineTo(
          arrowX - arrowSize * Math.cos(angle - Math.PI / 6),
          arrowY - arrowSize * Math.sin(angle - Math.PI / 6)
        );
        ctx.lineTo(
          arrowX - arrowSize * Math.cos(angle + Math.PI / 6),
          arrowY - arrowSize * Math.sin(angle + Math.PI / 6)
        );
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  /** Нарисовать линию-черновик при создании связи */
  drawDraftLine(fromNode, mouseX, mouseY) {
    const ctx = this.ctx;
    ctx.strokeStyle = '#e94560';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(fromNode.x, fromNode.y);
    ctx.lineTo(mouseX, mouseY);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** Нарисовать все узлы */
  drawNodes(nodes, selectedNode, connectingFrom) {
    for (const node of nodes) {
      this.drawNode(node, node === selectedNode, node === connectingFrom);
    }
  }

  drawNode(node, isSelected, isConnectingFrom) {
    const ctx = this.ctx;
    const { x, y, width, height, color, label } = node;
    const rx = 8, ry = 8;

    // Тень
    ctx.shadowColor = 'rgba(0,0,0,0.4)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 3;

    // Фон
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x - width / 2, y - height / 2, width, height, rx);
    ctx.fill();

    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    // Обводка
    if (isSelected || isConnectingFrom) {
      ctx.strokeStyle = '#e94560';
      ctx.lineWidth = 2.5;
      ctx.shadowColor = 'rgba(233, 69, 96, 0.5)';
      ctx.shadowBlur = 12;
      ctx.stroke();
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Текст
    ctx.fillStyle = '#e0e0e0';
    ctx.font = '13px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, y);
  }

  /** Нарисовать все частицы — сгруппированы по цвету для минимизации смены состояния */
  drawParticles(particles, time) {
    const ctx = this.ctx;
    if (particles.length === 0) return;

    // Group particles by (color, shadowBlur) to batch draw calls
    const groups = new Map();
    for (const p of particles) {
      const pulse = Math.sin(time * 0.005 + p.id * 0.7) * 0.3 + 0.7;
      let r, color;
      if (p.state === 'success') {
        r = 7 * (1 + Math.sin(time * 0.01 + p.id) * 0.3);
        color = '#66bb6a';
      } else if (p.state === 'error') {
        r = 7 * (1 + Math.sin(time * 0.01 + p.id) * 0.3);
        color = '#ef5350';
      } else if (p.type === 'sql') {
        r = 5 * pulse;
        color = '#64b5f6';
      } else {
        r = 5 * pulse;
        color = '#ffd54f';
      }
      const blur = (p.state === 'success' || p.state === 'error') ? 14 : 8;
      const key = `${color}|${blur}`;
      let group = groups.get(key);
      if (!group) {
        group = { color, blur, items: [] };
        groups.set(key, group);
      }
      group.items.push({ x: p.x, y: p.y, r });
    }

    for (const group of groups.values()) {
      ctx.fillStyle = group.color;
      ctx.shadowColor = group.color;
      ctx.shadowBlur = group.blur;
      ctx.beginPath();
      for (const { x, y, r } of group.items) {
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, Math.PI * 2);
      }
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  }
}