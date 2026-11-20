document.addEventListener('DOMContentLoaded', () => {
  Chart.register(ChartDataLabels);

  const COL = {
    PARCOURS:   "IAE - Version d'étape (lib. web)",
    REGIME:     "Régime d'inscription (lib.)",
    PROFIL:     "Profil étudiant (lib.)",
    COMPOSANTE: "Composante (lib.)",
    ANNEE_INSC: "Année de l'inscription",
    DIPLOME:    "Diplôme",
    ANNEE_DIPL: "Année de diplôme",
    DOUBLON:    "Doublon",
    DIPLOME_ON: "Diplômé (O/N)"
  };

  const PALETTE = [
    '#0ea5e9', '#1e3a8a', '#ea580c', '#6b21a8', '#db2777',
    '#059669', '#d97706', '#4f46e5', '#0d9488', '#dc2626'
  ];

  let raw = null;
  let colMap = {};        // Associe le libellé affiché au colId interne Grist
  let rowCount = 0;
  let currentTab = 'cover';
  let crossFilter = { col: null, val: null };
  let stageStatusMap = new Map(); // Map<etape, { init: bool, fc: bool, app: bool }>
  let charts = {};
  let lastPivotData = null;

  // Navigation entre onglets
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTab = btn.dataset.tab;

      document.getElementById('tab-cover').classList.toggle('active', currentTab === 'cover');
      document.getElementById('tab-analytics').classList.toggle('active', currentTab !== 'cover');

      const titleEl = document.getElementById('page-title');
      if (currentTab === 'cover') titleEl.textContent = "Analyse des inscriptions de l'UM";
      if (currentTab === 'regime') titleEl.textContent = "Répartition par Régime d'inscription";
      if (currentTab === 'annee') titleEl.textContent = "Évolution des effectifs par Année";

      if (currentTab !== 'cover' && raw) {
        updateDashboard();
      }
    });
  });

  // Récupération de la valeur d'une cellule par nom logique
  const valAt = (logicalName, i) => {
    const id = colMap[logicalName];
    if (!id || !raw[id]) return '';
    const v = raw[id][i];
    return v === null || v === undefined ? '' : String(v).trim();
  };

  // Pré-calcul des statuts au niveau de chaque étape (pour les 3 filtres roses)
  function buildStageStatusIndex() {
    stageStatusMap.clear();
    for (let i = 0; i < rowCount; i++) {
      const stage = valAt(COL.PARCOURS, i);
      if (!stage) continue;
      let st = stageStatusMap.get(stage);
      if (!st) {
        st = { init: false, fc: false, app: false };
        stageStatusMap.set(stage, st);
      }
      const reg = valAt(COL.REGIME, i).toLowerCase();
      if (reg.includes('initial')) st.init = true;
      if (reg.includes('apprentiss')) st.app = true;
      if (reg.includes('continue') || reg.includes('fc') || reg.includes('repr')) st.fc = true;
    }
  }

  // Remplissage des menus déroulants bleus
  function populateBlueFilters() {
    const mapping = [
      ['f-regime', COL.REGIME],
      ['f-profil', COL.PROFIL],
      ['f-composante', COL.COMPOSANTE],
      ['f-diplome-on', COL.DIPLOME_ON],
      ['f-diplome', COL.DIPLOME],
      ['f-annee-dipl', COL.ANNEE_DIPL],
      ['f-annee-insc', COL.ANNEE_INSC],
      ['f-doublon', COL.DOUBLON]
    ];

    mapping.forEach(([elId, logicalCol]) => {
      const sel = document.getElementById(elId);
      const uniques = new Set();
      for (let i = 0; i < rowCount; i++) {
        const v = valAt(logicalCol, i);
        if (v) uniques.add(v);
      }
      const sorted = Array.from(uniques).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      sorted.forEach(v => sel.appendChild(new Option(v, v)));
      sel.addEventListener('change', updateDashboard);
    });

    ['f-statut-init', 'f-statut-fc', 'f-statut-app'].forEach(id => {
      document.getElementById(id).addEventListener('change', updateDashboard);
    });

    document.getElementById('matrix-search').addEventListener('input', () => {
      if (lastPivotData) renderPivotTable(lastPivotData);
    });

    document.getElementById('btn-reset-all').addEventListener('click', () => {
      document.querySelectorAll('.filters-blue select, .filters-pink select').forEach(s => s.value = '');
      document.getElementById('matrix-search').value = '';
      crossFilter = { col: null, val: null };
      updateCrossClearButtons();
      updateDashboard();
    });

    document.getElementById('btn-export-csv').addEventListener('click', exportMatrixCSV);

    document.querySelectorAll('.clear-cross').forEach(btn => {
      btn.addEventListener('click', () => {
        crossFilter = { col: null, val: null };
        updateCrossClearButtons();
        updateDashboard();
      });
    });
  }

  function updateCrossClearButtons() {
    document.querySelectorAll('.clear-cross').forEach(btn => {
      btn.classList.toggle('visible', crossFilter.col === btn.dataset.col);
    });
  }

  function getFilteredIndices() {
    const fRegime = document.getElementById('f-regime').value;
    const fProfil = document.getElementById('f-profil').value;
    const fComp   = document.getElementById('f-composante').value;
    const fDipOn  = document.getElementById('f-diplome-on').value;
    const fDip    = document.getElementById('f-diplome').value;
    const fAnnDip = document.getElementById('f-annee-dipl').value;
    const fAnnIns = document.getElementById('f-annee-insc').value;
    const fDoub   = document.getElementById('f-doublon').value;

    const pInit   = document.getElementById('f-statut-init').value;
    const pFc     = document.getElementById('f-statut-fc').value;
    const pApp    = document.getElementById('f-statut-app').value;

    const indices = [];
    for (let i = 0; i < rowCount; i++) {
      if (fRegime && valAt(COL.REGIME, i) !== fRegime) continue;
      if (fProfil && valAt(COL.PROFIL, i) !== fProfil) continue;
      if (fComp   && valAt(COL.COMPOSANTE, i) !== fComp) continue;
      if (fDipOn  && valAt(COL.DIPLOME_ON, i) !== fDipOn) continue;
      if (fDip    && valAt(COL.DIPLOME, i) !== fDip) continue;
      if (fAnnDip && valAt(COL.ANNEE_DIPL, i) !== fAnnDip) continue;
      if (fAnnIns && valAt(COL.ANNEE_INSC, i) !== fAnnIns) continue;
      if (fDoub   && valAt(COL.DOUBLON, i) !== fDoub) continue;

      if (crossFilter.col && crossFilter.val) {
        if (valAt(crossFilter.col, i) !== crossFilter.val) continue;
      }

      if (pInit || pFc || pApp) {
        const st = stageStatusMap.get(valAt(COL.PARCOURS, i));
        if (!st) continue;
        if (pInit === 'oui' && !st.init) continue;
        if (pInit === 'non' && st.init) continue;
        if (pFc === 'oui' && !st.fc) continue;
        if (pFc === 'non' && st.fc) continue;
        if (pApp === 'oui' && !st.app) continue;
        if (pApp === 'non' && st.app) continue;
      }

      indices.push(i);
    }
    return indices;
  }

  // Agrégation croisée (Axe X × Série Y)
  function aggregate2D(indices, xCol, seriesCol, topN = 15) {
    const xTotals = new Map();
    const seriesSet = new Set();
    const matrix = new Map();

    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      const xVal = xCol ? (valAt(xCol, i) || 'Non renseigné') : 'TOTAL';
      const sVal = valAt(seriesCol, i) || 'Autre';

      seriesSet.add(sVal);
      xTotals.set(xVal, (xTotals.get(xVal) || 0) + 1);

      let rowMap = matrix.get(xVal);
      if (!rowMap) {
        rowMap = new Map();
        matrix.set(xVal, rowMap);
      }
      rowMap.set(sVal, (rowMap.get(sVal) || 0) + 1);
    }

    const sortedX = Array.from(xTotals.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(e => e[0]);

    const sortedSeries = Array.from(seriesSet).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    return { labels: sortedX, series: sortedSeries, matrix, xTotals };
  }

  function renderBarChart(canvasId, logicalXCol, indices, topN = 15) {
    const isRegimeMode = currentTab === 'regime';
    const seriesCol = isRegimeMode ? COL.REGIME : COL.ANNEE_INSC;
    const agg = aggregate2D(indices, logicalXCol, seriesCol, topN);

    const datasets = agg.series.map((sName, idx) => {
      const data = agg.labels.map(xLabel => {
        const count = agg.matrix.get(xLabel)?.get(sName) || 0;
        if (!isRegimeMode) return count;
        const tot = agg.xTotals.get(xLabel) || 1;
        return Math.round((count / tot) * 1000) / 10; // Pourcentage avec 1 décimale
      });

      return {
        label: sName,
        data,
        backgroundColor: PALETTE[idx % PALETTE.length],
        borderRadius: 2
      };
    });

    if (charts[canvasId]) charts[canvasId].destroy();

    const ctx = document.getElementById(canvasId).getContext('2d');
    charts[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: { labels: agg.labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        onClick: (e, elements) => {
          if (!logicalXCol || elements.length === 0) return;
          const idx = elements[0].index;
          const clickedLabel = agg.labels[idx];
          if (crossFilter.col === logicalXCol && crossFilter.val === clickedLabel) {
            crossFilter = { col: null, val: null };
          } else {
            crossFilter = { col: logicalXCol, val: clickedLabel };
          }
          updateCrossClearButtons();
          updateDashboard();
        },
        plugins: {
          legend: {
            display: canvasId !== 'chart-total',
            position: 'top',
            labels: { boxWidth: 10, font: { size: 10 }, padding: 6 }
          },
          tooltip: {
            callbacks: {
              label: (ctx) => isRegimeMode
                ? `${ctx.dataset.label} : ${ctx.parsed.y} %`
                : `${ctx.dataset.label} : ${ctx.parsed.y.toLocaleString('fr-FR')}`
            }
          },
            datalabels: {
            display: (ctx) => isRegimeMode && ctx.dataset.data[ctx.dataIndex] >= 12,
            color: '#fff',
            font: { weight: 'bold', size: 9.5 },
            formatter: (v) => `${Math.round(v)}%`
          }
        },
        scales: {
          x: {
            stacked: isRegimeMode,
            ticks: {
              font: { size: 10 },
              maxRotation: 65,
              minRotation: 0,
              callback: function(value) {
                const lbl = this.getLabelForValue(value);
                return lbl.length > 16 ? lbl.slice(0, 15) + '…' : lbl;
              }
            },
            grid: { display: false }
          },
          y: {
            stacked: isRegimeMode,
            max: isRegimeMode ? 100 : undefined,
            ticks: {
              font: { size: 10 },
              callback: (v) => isRegimeMode ? v + '%' : v
            }
          }
        }
      }
    });
  }

  function renderPivotTable(pivot) {
    const search = document.getElementById('matrix-search').value.toLowerCase().trim();
    const thead = document.getElementById('pivot-head');
    const tbody = document.getElementById('pivot-body');
    const tfoot = document.getElementById('pivot-foot');

    let headerHtml = `<tr><th>Version d'étape (lib. web)</th>`;
    pivot.series.forEach(s => { headerHtml += `<th>${s}</th>`; });
    headerHtml += `<th>Total</th></tr>`;
    thead.innerHTML = headerHtml;

    const colTotals = new Array(pivot.series.length).fill(0);
    let grandTotal = 0;
    let bodyHtml = '';

    pivot.labels.forEach(stage => {
      if (search && !stage.toLowerCase().includes(search)) return;
      const rowTotal = pivot.xTotals.get(stage) || 0;
      grandTotal += rowTotal;

      bodyHtml += `<tr><td title="${stage}">${stage}</td>`;
      pivot.series.forEach((s, idx) => {
        const val = pivot.matrix.get(stage)?.get(s) || 0;
        colTotals[idx] += val;
        bodyHtml += `<td>${val > 0 ? val.toLocaleString('fr-FR') : ''}</td>`;
      });
      bodyHtml += `<td><strong>${rowTotal.toLocaleString('fr-FR')}</strong></td></tr>`;
    });
    tbody.innerHTML = bodyHtml;

    let footHtml = `<tr><td>Total</td>`;
    colTotals.forEach(tot => { footHtml += `<td>${tot.toLocaleString('fr-FR')}</td>`; });
    footHtml += `<td>${grandTotal.toLocaleString('fr-FR')}</td></tr>`;
    tfoot.innerHTML = footHtml;
  }

  function exportMatrixCSV() {
    if (!lastPivotData) return;
    const lines = [];
    lines.push(['Formation', ...lastPivotData.series, 'Total'].join(';'));
    lastPivotData.labels.forEach(stage => {
      const row = [ `"${stage.replace(/"/g, '""')}"` ];
      lastPivotData.series.forEach(s => {
        row.push(lastPivotData.matrix.get(stage)?.get(s) || 0);
      });
      row.push(lastPivotData.xTotals.get(stage) || 0);
      lines.push(row.join(';'));
    });
    const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `export_apogee_${currentTab}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function updateDashboard() {
    const indices = getFilteredIndices();
    document.getElementById('badge-count').textContent = `${indices.length.toLocaleString('fr-FR')} lignes`;

    if (currentTab === 'cover') return;

    renderBarChart('chart-parcours',   COL.PARCOURS,   indices, 12);
    renderBarChart('chart-profil',     COL.PROFIL,     indices, 10);
    renderBarChart('chart-diplome',    COL.DIPLOME,    indices, 12);
    renderBarChart('chart-composante', COL.COMPOSANTE, indices, 15);
    renderBarChart('chart-anneedipl',  COL.ANNEE_DIPL, indices, 12);
    renderBarChart('chart-total',      null,           indices, 1);

    const seriesCol = currentTab === 'regime' ? COL.REGIME : COL.ANNEE_INSC;
    lastPivotData = aggregate2D(indices, COL.PARCOURS, seriesCol, 500);
    renderPivotTable(lastPivotData);
  }

  // Démarrage et connexion à la table Grist
  grist.ready({ requiredAccess: 'full' });

  async function init() {
    try {
      const tableId = await grist.selectedTable.getTableId();
      if (!tableId) return;

      const [tableData, colMeta, tableMeta] = await Promise.all([
        grist.docApi.fetchTable(tableId),
        grist.docApi.fetchTable('_grist_Tables_column'),
        grist.docApi.fetchTable('_grist_Tables')
      ]);

      raw = tableData;
      rowCount = raw.id ? raw.id.length : 0;

      // Résolution libellé affiché -> colId interne Grist
      const tIdx = tableMeta.tableId.indexOf(tableId);
      const parentId = tableMeta.id[tIdx];
      colMeta.parentId.forEach((pid, idx) => {
        if (pid === parentId) {
          const lbl = colMeta.label[idx] || colMeta.colId[idx];
          colMap[lbl] = colMeta.colId[idx];
        }
      });

      buildStageStatusIndex();
      populateBlueFilters();
      document.getElementById('badge-count').textContent = `${rowCount.toLocaleString('fr-FR')} lignes`;
      document.getElementById('loading-overlay').style.display = 'none';
    } catch (err) {
      console.error('Erreur chargement dashboard :', err);
      document.getElementById('loading-text').textContent = 'Erreur de chargement des données Grist.';
    }
  }

  init();
});
