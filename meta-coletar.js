// ============================================================
// ANIMEXTREME — Coleta Meta Ads API
// Roda via GitHub Actions a cada 6 horas
// Salva dados.json direto no repositório
// ============================================================

const https  = require('https');
const fs     = require('fs');
const path   = require('path');

// ── CONFIGURAÇÃO ──────────────────────────────────────────
const META_TOKEN  = process.env.META_TOKEN;
const DADOS_FILE  = path.join(__dirname, 'dados.json');

const CONTAS = [
  { id: 'act_648140282631963', nome: 'AX - AFAR Produtora' },
  // Adicione mais contas aqui conforme necessário:
  // { id: 'act_XXXXXXXXX', nome: 'Cliente 2' },
];

// Métricas que vamos buscar
const FIELDS = [
  'ad_id',
  'ad_name',
  'adset_name',
  'date_start',
  'spend',
  'impressions',
  'reach',
  'clicks',
  'ctr',
  'cpm',
  'frequency',
  'actions',
  'action_values',
].join(',');

// ── HELPERS ───────────────────────────────────────────────
function r2(n) { return Math.round((+n||0)*100)/100; }
function ri(n) { return Math.round(+n||0); }

function getAction(arr, types) {
  if (!arr) return 0;
  for (const type of (Array.isArray(types)?types:[types])) {
    const found = arr.find(x => x.action_type === type);
    if (found) return parseFloat(found.value)||0;
  }
  return 0;
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse error: ' + data.slice(0,300))); }
      });
    }).on('error', reject);
  });
}

// ── BUSCAR INSIGHTS ───────────────────────────────────────
async function buscarInsights(contaId, dataInicio, dataFim) {
  const baseUrl = 'https://graph.facebook.com/v19.0/' + contaId + '/insights?' +
    'fields=' + encodeURIComponent(FIELDS) +
    '&time_increment=1' +
    '&level=ad' +
    '&time_range=' + encodeURIComponent(JSON.stringify({ since: dataInicio, until: dataFim })) +
    '&limit=500' +
    '&access_token=' + META_TOKEN;

  let todos = [];
  let url   = baseUrl;

  while (url) {
    const res = await fetchJSON(url);
    if (res.error) throw new Error('Meta API erro: ' + res.error.message + ' (code: ' + res.error.code + ')');
    todos = todos.concat(res.data || []);
    url   = (res.paging && res.paging.next) || null;
    if (url) console.log('  Buscando página adicional...');
  }

  return todos;
}

// ── PROCESSAR ─────────────────────────────────────────────
function processar(rawData) {
  const porDia     = {};
  const porAnuncio = {};

  rawData.forEach(row => {
    const data = row.date_start;
    if (!data) return;

    const invest  = parseFloat(row.spend)       || 0;
    const imp     = parseInt(row.impressions)    || 0;
    const alcance = parseInt(row.reach)          || 0;
    const cliques = parseInt(row.clicks)         || 0;
    const addCart = getAction(row.actions, ['add_to_cart']);
    const compras = getAction(row.actions, ['purchase','omni_purchase']);
    const valComp = getAction(row.action_values, ['purchase','omni_purchase']);
    const adName  = row.ad_name   || 'Sem nome';
    const adSet   = row.adset_name|| '';

    // Agrega por dia
    if (!porDia[data]) porDia[data] = { data, impressoes:0, alcance:0, valorUsado:0, cliquesLink:0, addCarrinho:0, compras:0, valorCompras:0 };
    porDia[data].impressoes   += imp;
    porDia[data].alcance      += alcance;
    porDia[data].valorUsado   += invest;
    porDia[data].cliquesLink  += cliques;
    porDia[data].addCarrinho  += addCart;
    porDia[data].compras      += compras;
    porDia[data].valorCompras += valComp;

    // Agrega por anúncio + dia
    const key = adName + '||' + data;
    if (!porAnuncio[key]) porAnuncio[key] = { data, adName, adSet, impressoes:0, alcance:0, valorUsado:0, cliquesLink:0, addCarrinho:0, compras:0, valorCompras:0 };
    porAnuncio[key].impressoes   += imp;
    porAnuncio[key].alcance      += alcance;
    porAnuncio[key].valorUsado   += invest;
    porAnuncio[key].cliquesLink  += cliques;
    porAnuncio[key].addCarrinho  += addCart;
    porAnuncio[key].compras      += compras;
    porAnuncio[key].valorCompras += valComp;
  });

  const dias = Object.values(porDia)
    .filter(d => d.valorUsado > 0 || d.impressoes > 0)
    .map(d => ({
      data:             d.data,
      valorUsado:       r2(d.valorUsado),
      impressoes:       ri(d.impressoes),
      alcance:          ri(d.alcance),
      cliquesLink:      ri(d.cliquesLink),
      cliquesTodos:     ri(d.cliquesLink),
      resultados:       ri(d.compras),
      addCarrinho:      ri(d.addCarrinho),
      compras:          ri(d.compras),
      valorCompras:     r2(d.valorCompras),
      ctr:              d.impressoes > 0 ? r2(d.cliquesLink/d.impressoes*100) : 0,
      custoAddCarrinho: d.addCarrinho > 0 ? r2(d.valorUsado/d.addCarrinho) : 0,
      custoCompra:      d.compras > 0 ? r2(d.valorUsado/d.compras) : 0,
    }))
    .sort((a,b) => a.data.localeCompare(b.data));

  const anuncios = Object.values(porAnuncio)
    .filter(a => a.valorUsado > 0 || a.impressoes > 0)
    .map(a => ({
      data:        a.data,
      adName:      a.adName,
      adSet:       a.adSet,
      impressoes:  ri(a.impressoes),
      alcance:     ri(a.alcance),
      cliquesLink: ri(a.cliquesLink),
      addCarrinho: ri(a.addCarrinho),
      compras:     ri(a.compras),
      valorUsado:  r2(a.valorUsado),
      valorCompras:r2(a.valorCompras),
    }))
    .sort((a,b) => a.data.localeCompare(b.data) || a.adName.localeCompare(b.adName));

  return { dias, anuncios };
}

// ── MERGE DE MÚLTIPLAS CONTAS ─────────────────────────────
function mergeContas(resultados) {
  const porDia = {};
  const anuncios = [];

  resultados.forEach(({ dias, anuncios: ads }) => {
    dias.forEach(d => {
      if (!porDia[d.data]) {
        porDia[d.data] = { ...d };
      } else {
        const t = porDia[d.data];
        t.valorUsado   = r2(t.valorUsado   + d.valorUsado);
        t.impressoes   = ri(t.impressoes   + d.impressoes);
        t.alcance      = ri(t.alcance      + d.alcance);
        t.cliquesLink  = ri(t.cliquesLink  + d.cliquesLink);
        t.cliquesTodos = ri(t.cliquesTodos + d.cliquesTodos);
        t.addCarrinho  = ri(t.addCarrinho  + d.addCarrinho);
        t.compras      = ri(t.compras      + d.compras);
        t.resultados   = ri(t.resultados   + d.resultados);
        t.valorCompras = r2(t.valorCompras + d.valorCompras);
        t.ctr              = t.impressoes > 0 ? r2(t.cliquesLink/t.impressoes*100) : 0;
        t.custoAddCarrinho = t.addCarrinho > 0 ? r2(t.valorUsado/t.addCarrinho) : 0;
        t.custoCompra      = t.compras > 0 ? r2(t.valorUsado/t.compras) : 0;
      }
    });
    anuncios.push(...ads);
  });

  return {
    dias: Object.values(porDia).sort((a,b) => a.data.localeCompare(b.data)),
    anuncios,
  };
}

// ── MAIN ──────────────────────────────────────────────────
async function main() {
  if (!META_TOKEN) throw new Error('META_TOKEN não configurado nos secrets do GitHub');

  // Período: últimos 90 dias
  const hoje   = new Date();
  const inicio = new Date(hoje);
  inicio.setDate(inicio.getDate() - 90);
  const dataFim   = hoje.toISOString().slice(0,10);
  const dataInicio= inicio.toISOString().slice(0,10);

  console.log('Período:', dataInicio, 'até', dataFim);

  const resultados = [];

  for (const conta of CONTAS) {
    console.log('\nBuscando conta:', conta.nome, '(' + conta.id + ')');
    try {
      const raw = await buscarInsights(conta.id, dataInicio, dataFim);
      console.log('  Linhas brutas:', raw.length);
      const resultado = processar(raw);
      console.log('  Dias agregados:', resultado.dias.length);
      console.log('  Anúncios:', resultado.anuncios.length);
      resultados.push(resultado);
    } catch(e) {
      console.error('  Erro:', e.message);
      // Continua para a próxima conta
    }
  }

  if (!resultados.length) throw new Error('Nenhuma conta retornou dados.');

  const { dias, anuncios } = mergeContas(resultados);

  // Formata timestamp no horário de Brasília
  const agora = new Date().toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day:'2-digit', month:'2-digit', year:'numeric',
    hour:'2-digit', minute:'2-digit',
  });

  const json = JSON.stringify({ atualizadoEm: agora, dias, anuncios }, null, 2);

  // Salva dados.json no repositório
  fs.writeFileSync(DADOS_FILE, json, 'utf8');

  console.log('\nSalvo dados.json');
  console.log('Total de dias:', dias.length);
  console.log('Total de anúncios:', anuncios.length);
  console.log('Atualizado em:', agora);
}

main().catch(err => {
  console.error('ERRO FATAL:', err.message);
  process.exit(1);
});
