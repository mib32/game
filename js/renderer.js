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

  /** Подпись под узлом (статус) */
  _getNodeSubtitle(node) {
    if (node.type === 'PostgreSQL') {
      const conn = node.activeConnections;
      const max = node.maxConnections;
      const db = node.dbSize;
      return `${conn}/${max} conn · DB: ${db}`;
    }
    if (node.type === 'Backend' && node.pendingParents > 0) {
      return `pending: ${node.pendingParents}`;
    }
    return null;
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
    const { x, y, width, height, label } = node;
    let color = node.color;

    // Визуальная индикация при перегрузке PostgreSQL
    if (node.type === 'PostgreSQL' && node.activeConnections >= node.maxConnections) {
      color = '#3a1a1a'; // красноватый оттенок
    }

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
    ctx.fillText(label, x, y - 4);

    // Subtitle: статус узла
    const subtitle = this._getNodeSubtitle(node);
    if (subtitle) {
      ctx.fillStyle = '#888';
      ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(subtitle, x, y + 12);
    }
  }

  /** Нарисовать все частицы */
  drawParticles(particles, time) {
    const ctx = this.ctx;
    if (particles.length === 0) return;

    for (const p of particles) {
      // Терминальные состояния — рисуем вспышку-кольцо
      if (p.state === 'success' || p.state === 'error') {
        if (p.stateChangedAt != null) {
          const elapsed = time - p.stateChangedAt;
          const flashProgress = Math.min(elapsed / 400, 1);
          const ringR = 5 + flashProgress * 15;
          const alpha = 1 - flashProgress;
          ctx.strokeStyle = p.state === 'success'
            ? `rgba(102, 187, 106, ${alpha})`
            : `rgba(239, 83, 80, ${alpha})`;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(p.x, p.y, ringR, 0, Math.PI * 2);
          ctx.stroke();
        }
        continue;
      }

      // Родитель ждёт на Backend — жёлтая пульсация
      if (p.state === 'pending') {
        const pulse = Math.sin(time * 0.006 + p.id * 0.7) * 0.4 + 0.6;
        const r = 7 * pulse;
        ctx.fillStyle = '#ffd54f';
        ctx.shadowColor = '#ffd54f';
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;

        // Кольцо ожидания
        ctx.strokeStyle = 'rgba(255, 213, 79, 0.3)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
        ctx.stroke();
        continue;
      }

      // В процессинге на PostgreSQL — синяя пульсация + прогресс-кольцо
      if (p.state === 'processing') {
        const pulse = Math.sin(time * 0.006 + p.id * 0.7) * 0.3 + 0.7;
        const r = 5 * pulse;
        ctx.fillStyle = '#64b5f6';
        ctx.shadowColor = '#64b5f6';
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();

        // Прогресс-кольцо
        if (p.processingStartedAt != null) {
          const pt = p._totalProcessingTime || p.baseProcessingTime || 500;
          const elapsed = time - p.processingStartedAt;
          const progress = Math.min(elapsed / pt, 1);
          ctx.strokeStyle = 'rgba(100, 181, 246, 0.6)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 9, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
          ctx.stroke();
        }
        ctx.shadowBlur = 0;
        continue;
      }

      // travelling: в пути
      const pulse = Math.sin(time * 0.005 + p.id * 0.7) * 0.1 + 0.9;
      const r = 5 * pulse;
      const color = p.type === 'sql' ? '#64b5f6' : '#ffd54f';

      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }
}