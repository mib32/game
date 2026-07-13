/**
 * Renderer — вся отрисовка на canvas.
 * Узлы, связи, частицы, временная линия при создании связи.
 */
export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;
    this.resize();
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.canvas.width = rect.width * this.dpr;
    this.canvas.height = rect.height * this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.width = rect.width;
    this.height = rect.height;
  }

  clear() {
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.drawGrid();
  }

  drawGrid() {
    const ctx = this.ctx;
    const step = 40;
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 1;
    for (let x = step; x < this.width; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.height);
      ctx.stroke();
    }
    for (let y = step; y < this.height; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.width, y);
      ctx.stroke();
    }
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

  /** Нарисовать все частицы */
  drawParticles(particles, time) {
    const ctx = this.ctx;
    for (const p of particles) {
      const pulse = Math.sin(time * 0.005 + p.id * 0.7) * 0.3 + 0.7;
      const r = p.state === 'success' || p.state === 'error'
        ? 7 * (1 + Math.sin(time * 0.01 + p.id) * 0.3) // вспышка поярче
        : 5 * pulse;

      let color;
      if (p.state === 'success') color = '#66bb6a';
      else if (p.state === 'error') color = '#ef5350';
      else if (p.type === 'sql') color = '#64b5f6';
      else color = '#ffd54f'; // api

      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = p.state === 'success' || p.state === 'error' ? 14 : 8;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }
}