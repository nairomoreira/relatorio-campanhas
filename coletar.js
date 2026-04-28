// ============================================================
// ANIMEXTREME — Coleta Meta Ads API
// Roda via GitHub Actions a cada 6 horas
// Salva dados.json direto no repositório
// ============================================================

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const META_TOKEN = process.env.META_TOKEN;
const DADOS_FILE = path.join(__dirname, 'dados.json');

const CONTAS = [
  { id: 'act_648140282631963', nome: 'AX - AFAR Produtora' },
  // { id: 'act_XXXXXXXXX', nome: 'Cliente 2' },
];

const FIELDS = [
  'ad_id', 'ad_name', 'adset_name', 'campaign_name',
  'date_start', 'spend', 'impressions', 'reach',
  'clicks', 'ctr', 'cpm', 'frequency',
  'actions', 'action_values',
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
    '&time_increment=1&level=ad' +
    '&time_range=' + encodeURIComponent(JSON.stringify({ since: dataInicio, until: dataFim })) +
    '&limit=500&access_token=' + META_TOKEN;

  let todos = [], url = baseUrl;
  while (url) {
    const res = await fetchJSON(url);
    if (res.error) throw new Error('Meta API: ' + res.error.message);
    todos = todos.concat(res.data || []);
    url = (res.paging && res.paging.next) || null;
  }
  return todos;
}

// ── BUSCAR CRIATIVO DE UM ANÚNCIO ─────────────────────────
async function buscarCriativo(adId) {
  try {
    const url = 'https://graph.facebook.com/v19.0/' + adId +
      '?fields=creative{id,name,thumbnail_url,image_url,video_id,object_story_spec,asset_feed_spec}' +
      '&access_token=' + META_TOKEN;
    const res = await fetchJSON(url);
    if (!res.creative) return null;
    const c = res.creative;

    // Tenta pegar thumbnail — vídeo tem thumbnail_url, imagem tem image_url
    let imageUrl = c.thumbnail_url || c.image_url || null;

    // Se for vídeo e não tiver thumbnail direto, busca pelo video_id
    if (!imageUrl && c.video_id) {
      const vUrl = 'https://graph.facebook.com/v19.0/' + c.video_id +
        '?fields=thumbnails{uri}&access_token=' + META_TOKEN;
      const vRes = await fetchJSON(vUrl);
      if (vRes.thumbnails && vRes.thumbnails.data && vRes.thumbnails.data.length) {
        imageUrl = vRes.thumbnails.data[0].uri;
      }
    }

    return {
      creativeId:  c.id,
      creativeName:c.name || '',
      imageUrl,
      tipo: c.video_id ? 'video' : 'imagem',
    };
  } catch(e) {
    console.log('  Criativo não encontrado para ad', adId, ':', e.message);
    return null;
  }
}

// ── PROCESSAR ─────────────────────────────────────────────
function processar(rawData) {
  const porDia     = {};
  const porAnuncio = {}; // key: adName
  const adIds      = {}; // adName → adId (para buscar criativo)

  rawData.forEach(row => {
    const data = row.date_start;
    if (!data) return;

    const invest   = parseFloat(row.spend)    || 0;
    const imp      = parseInt(row.impressions) || 0;
    const alcance  = parseInt(row.reach)       || 0;
    const cliques  = parseInt(row.clicks)      || 0;
    const freq     = parseFloat(row.frequency) || 0;
    const addCart  = getAction(row.actions, ['add_to_cart']);
    const compras  = getAction(row.actions, ['purchase','omni_purchase']);
    const valComp  = getAction(row.action_values, ['purchase','omni_purchase']);
    const adName   = row.ad_name    || 'Sem nome';
    const adSet    = row.adset_name || '';
    const campaign = row.campaign_name || '';
    const adId     = row.ad_id || '';

    // Guarda ad_id por nome (para buscar criativo depois)
    if (adId && !adIds[adName]) adIds[adName] = adId;

    // Agrega por dia
    if (!porDia[data]) porDia[data] = { data, impressoes:0, alcance:0, valorUsado:0, cliquesLink:0, addCarrinho:0, compras:0, valorCompras:0 };
    const dia = porDia[data];
    dia.impressoes   += imp;
    dia.alcance      += alcance;
    dia.valorUsado   += invest;
    dia.cliquesLink  += cliques;
    dia.addCarrinho  += addCart;
    dia.compras      += compras;
    dia.valorCompras += valComp;

    // Agrega por anúncio (total do período)
    if (!porAnuncio[adName]) {
      porAnuncio[adName] = {
        adName, adSet, campaign,
        impressoes:0, alcance:0, valorUsado:0, cliquesLink:0,
        addCarrinho:0, compras:0, valorCompras:0, freq:0, _dias:0,
      };
    }
    const ad = porAnuncio[adName];
    ad.impressoes   += imp;
    ad.alcance      += alcance;
    ad.valorUsado   += invest;
    ad.cliquesLink  += cliques;
    ad.addCarrinho  += addCart;
    ad.compras      += compras;
    ad.valorCompras += valComp;
    ad.freq         += freq;
    ad._dias        += 1;
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

  // Anúncios agregados (para ranking e criativos)
  const anuncios = Object.values(porAnuncio)
    .filter(a => a.valorUsado > 0 || a.impressoes > 0)
    .map(a => ({
      adId:        adIds[a.adName] || '',
      adName:      a.adName,
      adSet:       a.adSet,
      campaign:    a.campaign,
      impressoes:  ri(a.impressoes),
      alcance:     ri(a.alcance),
      cliquesLink: ri(a.cliquesLink),
      addCarrinho: ri(a.addCarrinho),
      compras:     ri(a.compras),
      valorUsado:  r2(a.valorUsado),
      valorCompras:r2(a.valorCompras),
      ctr:         a.impressoes > 0 ? r2(a.cliquesLink/a.impressoes*100) : 0,
      cpm:         a.impressoes > 0 ? r2(a.valorUsado/a.impressoes*1000) : 0,
      cpc:         a.cliquesLink > 0 ? r2(a.valorUsado/a.cliquesLink) : 0,
      roas:        a.valorUsado > 0 ? r2(a.valorCompras/a.valorUsado) : 0,
      custoCompra: a.compras > 0 ? r2(a.valorUsado/a.compras) : 0,
      freq:        a._dias > 0 ? r2(a.freq/a._dias) : 0,
    }))
    .sort((a,b) => b.compras - a.compras || b.valorCompras - a.valorCompras);

  // Também retorna dados por anúncio+dia (para o ranking filtrado por período)
  const anunciosDia = [];
  rawData.forEach(row => {
    const data = row.date_start;
    if (!data) return;
    const invest  = parseFloat(row.spend)    || 0;
    const imp     = parseInt(row.impressions) || 0;
    const compras = getAction(row.actions, ['purchase','omni_purchase']);
    const valComp = getAction(row.action_values, ['purchase','omni_purchase']);
    anunciosDia.push({
      data,
      adName:      row.ad_name || 'Sem nome',
      adSet:       row.adset_name || '',
      impressoes:  ri(imp),
      alcance:     ri(parseInt(row.reach)||0),
      cliquesLink: ri(parseInt(row.clicks)||0),
      addCarrinho: ri(getAction(row.actions,['add_to_cart'])),
      compras:     ri(compras),
      valorUsado:  r2(invest),
      valorCompras:r2(valComp),
    });
  });

  return { dias, anuncios, anunciosDia };
}

// ── BUSCAR CRIATIVOS DOS TOP ANÚNCIOS ─────────────────────
async function buscarCriativos(anuncios) {
  // Busca criativos apenas dos top 10 por ROAS (evita muitas chamadas)
  const top = anuncios
    .filter(a => a.adId && a.valorUsado > 5) // mínimo R$5 investido
    .sort((a,b) => b.roas - a.roas)
    .slice(0, 10);

  console.log('  Buscando criativos de', top.length, 'anúncios...');

  const criativos = [];
  for (const ad of top) {
    const criativo = await buscarCriativo(ad.adId);
    if (criativo && criativo.imageUrl) {
      criativos.push({
        adId:        ad.adId,
        adName:      ad.adName,
        adSet:       ad.adSet,
        campaign:    ad.campaign || '',
        imageUrl:    criativo.imageUrl,
        tipo:        criativo.tipo,
        // Métricas de performance
        roas:        ad.roas,
        ctr:         ad.ctr,
        cpc:         ad.cpc,
        cpm:         ad.cpm,
        alcance:     ad.alcance,
        impressoes:  ad.impressoes,
        cliquesLink: ad.cliquesLink,
        compras:     ad.compras,
        valorCompras:ad.valorCompras,
        valorUsado:  ad.valorUsado,
        custoCompra: ad.custoCompra,
        freq:        ad.freq,
      });
    }
    // Pausa pequena para não sobrecarregar a API
    await new Promise(r => setTimeout(r, 200));
  }

  console.log('  Criativos com imagem:', criativos.length);
  return criativos;
}

// ── MERGE DE MÚLTIPLAS CONTAS ─────────────────────────────
function mergeContas(resultados) {
  const porDia = {};
  const anuncios = [], anunciosDia = [];

  resultados.forEach(({ dias, anuncios: ads, anunciosDia: adsDia }) => {
    dias.forEach(d => {
      if (!porDia[d.data]) { porDia[d.data] = { ...d }; }
      else {
        const t = porDia[d.data];
        t.valorUsado   = r2(t.valorUsado + d.valorUsado);
        t.impressoes   = ri(t.impressoes + d.impressoes);
        t.alcance      = ri(t.alcance + d.alcance);
        t.cliquesLink  = ri(t.cliquesLink + d.cliquesLink);
        t.cliquesTodos = ri(t.cliquesTodos + d.cliquesTodos);
        t.addCarrinho  = ri(t.addCarrinho + d.addCarrinho);
        t.compras      = ri(t.compras + d.compras);
        t.resultados   = ri(t.resultados + d.resultados);
        t.valorCompras = r2(t.valorCompras + d.valorCompras);
        t.ctr              = t.impressoes > 0 ? r2(t.cliquesLink/t.impressoes*100) : 0;
        t.custoAddCarrinho = t.addCarrinho > 0 ? r2(t.valorUsado/t.addCarrinho) : 0;
        t.custoCompra      = t.compras > 0 ? r2(t.valorUsado/t.compras) : 0;
      }
    });
    anuncios.push(...ads);
    anunciosDia.push(...(adsDia||[]));
  });

  return {
    dias: Object.values(porDia).sort((a,b) => a.data.localeCompare(b.data)),
    anuncios,
    anunciosDia,
  };
}

// ── MAIN ──────────────────────────────────────────────────
// ── VERIFICAR EXPIRAÇÃO DO TOKEN ─────────────────────────
async function verificarToken() {
  try {
    const url = 'https://graph.facebook.com/v19.0/me?fields=id&access_token=' + META_TOKEN;
    const res = await fetchJSON(url);
    if (res.error) return null;

    // Debugger endpoint para ver expiração
    const debugUrl = 'https://graph.facebook.com/v19.0/debug_token?' +
      'input_token=' + META_TOKEN +
      '&access_token=' + META_TOKEN;
    const debug = await fetchJSON(debugUrl);
    if (debug.data && debug.data.expires_at) {
      const exp = new Date(debug.data.expires_at * 1000);
      console.log('Token expira em:', exp.toLocaleDateString('pt-BR'));
      return exp.toISOString();
    }
    return null;
  } catch(e) {
    console.log('Não foi possível verificar expiração do token:', e.message);
    return null;
  }
}

async function main() {
  if (!META_TOKEN) throw new Error('META_TOKEN não configurado');

  const hoje   = new Date();
  const inicio = new Date(hoje); inicio.setDate(inicio.getDate() - 90);
  const dataFim    = hoje.toISOString().slice(0,10);
  const dataInicio = inicio.toISOString().slice(0,10);

  console.log('Período:', dataInicio, 'até', dataFim);

  const resultados = [];
  for (const conta of CONTAS) {
    console.log('\nBuscando conta:', conta.nome);
    try {
      const raw = await buscarInsights(conta.id, dataInicio, dataFim);
      console.log('  Linhas brutas:', raw.length);
      const resultado = processar(raw);
      console.log('  Dias:', resultado.dias.length, '| Anúncios:', resultado.anuncios.length);
      resultados.push(resultado);
    } catch(e) {
      console.error('  Erro:', e.message);
    }
  }

  if (!resultados.length) throw new Error('Nenhuma conta retornou dados.');

  const { dias, anuncios, anunciosDia } = mergeContas(resultados);

  // Busca criativos dos top anúncios
  console.log('\nBuscando criativos...');
  const criativos = await buscarCriativos(anuncios);

  const agora = new Date().toLocaleString('pt-BR', {
    timeZone:'America/Sao_Paulo',
    day:'2-digit',month:'2-digit',year:'numeric',
    hour:'2-digit',minute:'2-digit',
  });

  // Verifica expiração do token
  console.log('\nVerificando token...');
  const tokenExpira = await verificarToken();

  const json = JSON.stringify({
    atualizadoEm: agora,
    tokenExpira,
    dias,
    anuncios:    anunciosDia,
    criativos,
  }, null, 2);

  fs.writeFileSync(DADOS_FILE, json, 'utf8');

  console.log('\n✓ dados.json salvo');
  console.log('  Dias:', dias.length);
  console.log('  Linhas anúncios:', anunciosDia.length);
  console.log('  Criativos:', criativos.length);
  console.log('  Atualizado em:', agora);
}

main().catch(err => {
  console.error('ERRO FATAL:', err.message);
  process.exit(1);
});
