'use strict';

/* =========================================================
   Controle de Exames — dados guardados no Supabase (online),
   acessíveis somente após login.
   ========================================================= */

const TIPOS = {
  exames: { singular: 'exame', campo: 'exame' },
  medicos: { singular: 'médico', campo: 'medico' },
  convenios: { singular: 'convênio', campo: 'convenio' }
};
const OBS_RAPIDAS = ['PAGO', 'Judicial'];
const OLHOS = { AO: 'Ambos os olhos', OD: 'Olho direito', OE: 'Olho esquerdo' };
const olhoValido = v => Object.hasOwn(OLHOS, v) ? v : null;
const POR_PAGINA = 100;
const DIAS_LEMBRETE_BACKUP = 7;

const dados = { exames: [], medicos: [], convenios: [], lancamentos: [] };
let sb; // cliente do Supabase

/* ---------- Utilidades ---------- */

const $ = (sel, raiz = document) => raiz.querySelector(sel);
const $$ = (sel, raiz = document) => [...raiz.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const normal = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const num = n => n.toLocaleString('pt-BR');
const pad = n => String(n).padStart(2, '0');
const isoLocal = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hoje = () => isoLocal(new Date());
const dataBR = iso => iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '—';
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const mesBR = ym => `${MESES[+ym.slice(5, 7) - 1]}/${ym.slice(0, 4)}`;

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function baixar(nome, conteudo, tipo) {
  const url = URL.createObjectURL(new Blob([conteudo], { type: tipo }));
  const a = Object.assign(document.createElement('a'), { href: url, download: nome });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

let toastTimer;
function aviso(texto, acao, fn, ms = 5000) {
  const el = $('#toast'), btn = $('#toast-acao');
  $('#toast-texto').textContent = texto;
  btn.hidden = !acao;
  btn.textContent = acao || '';
  btn.onclick = () => { el.hidden = true; fn && fn(); };
  el.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/* ---------- Banco de dados (Supabase) ---------- */

const LOTE = 1000; // o Supabase devolve no máximo 1000 linhas por consulta
const COLUNAS_LANC = 'id,data,paciente,prontuario,exame,medico,convenio,olho,obs';
const camposLanc = r => ({
  data: r.data, paciente: r.paciente || '', prontuario: r.prontuario || '',
  exame: r.exame, medico: r.medico || null, convenio: r.convenio || null,
  olho: olhoValido(r.olho), obs: r.obs || ''
});
const camposCad = i => ({ id: i.id, nome: i.nome, ativo: i.ativo !== false });

async function resposta(consulta) {
  const { data, error } = await consulta;
  if (error) throw new Error(error.message);
  return data;
}

function emLotes(lista, tamanho = LOTE) {
  const lotes = [];
  for (let i = 0; i < lista.length; i += tamanho) lotes.push(lista.slice(i, i + tamanho));
  return lotes;
}

// Executa tarefas com no máximo `limite` ao mesmo tempo.
async function emParalelo(tarefas, limite = 6) {
  const resultados = [];
  let proxima = 0;
  const trabalhador = async () => {
    while (proxima < tarefas.length) {
      const i = proxima++;
      resultados[i] = await tarefas[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limite, tarefas.length) }, trabalhador));
  return resultados;
}

// Registros sem id são inseridos (e recebem o id do banco); com id, são atualizados.
async function gravar(loja, itens, progresso) {
  if (loja !== 'lancamentos') {
    await resposta(sb.from(loja).upsert(itens.map(camposCad)));
    return;
  }
  const novos = itens.filter(i => i.id == null);
  let feitos = 0;
  for (const lote of emLotes(novos)) {
    const ids = await resposta(sb.from('lancamentos').insert(lote.map(camposLanc)).select('id'));
    ids.forEach((r, i) => { lote[i].id = r.id; });
    feitos += lote.length;
    if (progresso) progresso(feitos, novos.length);
  }
  for (const r of itens.filter(i => !novos.includes(i))) {
    await resposta(sb.from('lancamentos').update(camposLanc(r)).eq('id', r.id));
  }
}

const apagar = (loja, ids) => resposta(sb.from(loja).delete().in('id', ids));

async function substituirTudo(novo, progresso) {
  await resposta(sb.from('lancamentos').delete().gte('id', 0));
  for (const t of Object.keys(TIPOS)) {
    await resposta(sb.from(t).delete().gte('id', -2147483648));
    if (novo[t].length) await gravar(t, novo[t]);
  }
  const lanc = novo.lancamentos.map(r => ({ ...camposLanc(r) }));
  await gravar('lancamentos', lanc, progresso);
  await carregar();
}

let carregadoEm = 0;
async function carregar() {
  const [exames, medicos, convenios, total] = await Promise.all([
    ...Object.keys(TIPOS).map(t => resposta(sb.from(t).select('id,nome,ativo').order('id'))),
    sb.from('lancamentos').select('id', { count: 'exact', head: true }).then(r => {
      if (r.error) throw new Error(r.error.message);
      return r.count || 0;
    })
  ]);
  const paginas = await emParalelo(Array.from({ length: Math.ceil(total / LOTE) }, (_, i) =>
    () => resposta(sb.from('lancamentos').select(COLUNAS_LANC).order('id').range(i * LOTE, (i + 1) * LOTE - 1))));
  Object.assign(dados, { exames, medicos, convenios, lancamentos: paginas.flat() });
  carregadoEm = Date.now();
  invalidar();
}

// Pequenas preferências deste aparelho (ex.: data da última cópia de segurança).
const meta = {
  get(chave) { try { return localStorage.getItem('exames:' + chave); } catch { return null; } },
  set(chave, valor) { try { localStorage.setItem('exames:' + chave, valor); } catch { /* sem armazenamento */ } }
};

/* ---------- Índices calculados (refeitos quando os dados mudam) ---------- */

let cache = {};
function invalidar() { cache = {}; }

function mapa(tipo) {
  return cache['mapa-' + tipo] ||= new Map(dados[tipo].map(i => [i.id, i]));
}
const nomeDe = (tipo, id) => mapa(tipo).get(id)?.nome ?? (id == null ? '—' : `Código ${id}`);

// Quantas vezes cada item foi usado (total e no último ano), para ordenar e mostrar.
function usos(tipo) {
  if (cache['usos-' + tipo]) return cache['usos-' + tipo];
  const campo = TIPOS[tipo].campo;
  const limite = isoLocal(new Date(Date.now() - 365 * 864e5));
  const total = new Map(), recente = new Map();
  for (const r of dados.lancamentos) {
    const v = r[campo];
    total.set(v, (total.get(v) || 0) + 1);
    if (r.data >= limite) recente.set(v, (recente.get(v) || 0) + 1);
  }
  return cache['usos-' + tipo] = { total, recente };
}

function ativosPorUso(tipo) {
  const { recente, total } = usos(tipo);
  return dados[tipo].filter(i => i.ativo !== false).sort((a, b) =>
    (recente.get(b.id) || 0) - (recente.get(a.id) || 0) ||
    (total.get(b.id) || 0) - (total.get(a.id) || 0) || a.id - b.id);
}

const porNome = (a, b) => a.nome.localeCompare(b.nome, 'pt-BR');

// O prontuário tem o formato "número do paciente/sequência do atendimento" (ex.: 2634805/92).
// O paciente é identificado pelo número antes da barra.
const numeroPaciente = pront => String(pront ?? '').split('/')[0].trim();
const chavePaciente = r => numeroPaciente(r.prontuario) || 'nome:' + normal(r.paciente);

// Pacientes únicos, com o último atendimento de cada um.
function pacientes() {
  if (cache.pacientes) return cache.pacientes;
  const m = new Map();
  for (const r of dados.lancamentos) {
    if (!r.paciente) continue;
    const chave = chavePaciente(r);
    const p = m.get(chave);
    if (!p || r.data > p.ultimo.data || (r.data === p.ultimo.data && r.id > p.ultimo.id)) {
      m.set(chave, { chave, nome: r.paciente, numero: numeroPaciente(r.prontuario), norm: normal(r.paciente), ultimo: r });
    }
  }
  return cache.pacientes = [...m.values()].sort((a, b) => b.ultimo.data.localeCompare(a.ultimo.data));
}

function pacientePorProntuario(pront) {
  cache.porNumero ||= new Map(pacientes().filter(p => p.numero).map(p => [p.numero, p]));
  return cache.porNumero.get(numeroPaciente(pront));
}

function obsFrequentes() {
  if (cache.obs) return cache.obs;
  const c = new Map();
  for (const r of dados.lancamentos) {
    const o = (r.obs || '').trim();
    if (o && o.length <= 40) c.set(o, (c.get(o) || 0) + 1);
  }
  return cache.obs = [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(e => e[0]);
}

/* ---------- Selects ---------- */

function preencherSelect(sel, tipo, { vazio = 'Selecione…', incluirInativos = false, maisUsados = false } = {}) {
  const atual = sel.value;
  const lista = dados[tipo].filter(i => incluirInativos || i.ativo !== false).sort(porNome);
  let html = `<option value="">${esc(vazio)}</option>`;
  if (maisUsados && lista.length > 8) {
    const top = ativosPorUso(tipo).slice(0, 5);
    html += `<optgroup label="Mais usados">${top.map(i => `<option value="${i.id}">${esc(i.nome)}</option>`).join('')}</optgroup>`;
    html += `<optgroup label="Todos">`;
  }
  html += lista.map(i => `<option value="${i.id}">${esc(i.nome)}${i.ativo === false ? ' (inativo)' : ''}</option>`).join('');
  if (maisUsados && lista.length > 8) html += '</optgroup>';
  sel.innerHTML = html;
  sel.value = atual;
}

function atualizarSelects() {
  const fa = $('#form-atendimento');
  preencherSelect(fa.medico, 'medicos', { maisUsados: true });
  preencherSelect(fa.convenio, 'convenios', { maisUsados: true });
  const ff = $('#filtros');
  preencherSelect(ff.exame, 'exames', { vazio: 'Todos', incluirInativos: true });
  preencherSelect(ff.medico, 'medicos', { vazio: 'Todos', incluirInativos: true });
  preencherSelect(ff.convenio, 'convenios', { vazio: 'Todos', incluirInativos: true });
  preencherSelect($('#rel-medico'), 'medicos', { vazio: 'Todos', incluirInativos: true });
  preencherSelect($('#rel-convenio'), 'convenios', { vazio: 'Todos', incluirInativos: true });
  $('#lista-obs').innerHTML = obsFrequentes().map(o => `<option value="${esc(o)}">`).join('');
}

/* ---------- Tabela de registros ---------- */

function tabela(lista, { comData = true } = {}) {
  if (!lista.length) return '<p class="vazio">Nenhum registro.</p>';
  return `<table class="registros"><thead><tr>
      ${comData ? '<th>Data</th>' : ''}<th>Paciente</th><th>Exame</th><th>Médico</th><th>Convênio</th><th>Obs.</th>
    </tr></thead><tbody>${lista.map(r => `<tr data-id="${r.id}">
      ${comData ? `<td class="data">${dataBR(r.data)}</td>` : ''}
      <td><div class="nome">${esc(r.paciente || '(sem nome)')}</div>${r.prontuario ? `<div class="sub">Pront. ${esc(r.prontuario)}</div>` : ''}</td>
      <td>${esc(nomeDe('exames', r.exame))}${r.olho ? ` <span class="olho" title="${OLHOS[r.olho]}">${r.olho}</span>` : ''}</td>
      <td>${esc(nomeDe('medicos', r.medico))}</td>
      <td>${esc(nomeDe('convenios', r.convenio))}</td>
      <td class="sub">${esc(r.obs || '')}</td>
    </tr>`).join('')}</tbody></table>`;
}

function ligarCliquesTabela(container) {
  container.addEventListener('click', e => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) abrirEdicao(+tr.dataset.id);
  });
}

const ordenarRecentes = (a, b) => b.data.localeCompare(a.data) || b.id - a.id;

/* ---------- Aba: Atendimento ---------- */

// Exames marcados no atendimento → olho escolhido para cada um (AO, OD, OE ou null).
const examesSelecionados = new Map();

function renderFichasExames() {
  $('#fichas-exames').innerHTML = ativosPorUso('exames').map(e =>
    `<button type="button" data-id="${e.id}" aria-pressed="${examesSelecionados.has(e.id)}">${esc(e.nome)}</button>`).join('')
    || '<span class="ajuda">Cadastre os exames em Ajustes.</span>';
  renderOlhos();
}

function renderOlhos() {
  const el = $('#olhos-exames');
  el.innerHTML = [...examesSelecionados].map(([id, olho]) => `<div class="linha-olho" data-id="${id}">
      <span class="nome">${esc(nomeDe('exames', id))}</span>
      <span class="olhos">${Object.entries(OLHOS).map(([k, t]) =>
        `<button type="button" data-olho="${k}" title="${t}" aria-pressed="${olho === k}">${k}</button>`).join('')}</span>
    </div>`).join('');
  el.hidden = !examesSelecionados.size;
}

function renderListaDia() {
  const data = $('#form-atendimento').data.value || hoje();
  const lista = dados.lancamentos.filter(r => r.data === data).sort((a, b) => b.id - a.id);
  $('#titulo-dia').textContent = data === hoje() ? 'Registros de hoje' : `Registros de ${dataBR(data)}`;
  const pac = new Set(lista.map(chavePaciente)).size;
  $('#contagem-dia').textContent = lista.length ? `${num(lista.length)} exame(s) · ${num(pac)} paciente(s)` : '';
  $('#lista-dia').innerHTML = tabela(lista, { comData: false });
}

function mostrarHistorico(p) {
  const el = $('#historico-paciente');
  if (!p) { el.hidden = true; return; }
  const u = p.ultimo;
  const mesmoDia = dados.lancamentos.filter(r => r.data === u.data && chavePaciente(r) === p.chave);
  const exames = [...new Set(mesmoDia.map(r => nomeDe('exames', r.exame)))].join(', ');
  el.innerHTML = `Último atendimento em <strong>${dataBR(u.data)}</strong>: ${esc(exames)} · ${esc(nomeDe('medicos', u.medico))} · ${esc(nomeDe('convenios', u.convenio))}`;
  el.hidden = false;
}

function escolherPaciente(p) {
  const f = $('#form-atendimento');
  f.paciente.value = p.nome;
  const u = p.ultimo;
  if (!f.medico.value && mapa('medicos').get(u.medico)?.ativo !== false) f.medico.value = u.medico;
  if (!f.convenio.value && mapa('convenios').get(u.convenio)?.ativo !== false) f.convenio.value = u.convenio;
  mostrarHistorico(p);
  fecharSugestoes();
  // Preenche o número do paciente e deixa o cursor pronto para digitar a sequência do atendimento.
  if (p.numero && numeroPaciente(f.prontuario.value) !== p.numero) {
    f.prontuario.value = p.numero + '/';
    f.prontuario.focus();
    f.prontuario.setSelectionRange(f.prontuario.value.length, f.prontuario.value.length);
  }
}

let sugestoesAtuais = [], sugestaoFoco = -1;
function fecharSugestoes() { $('#sugestoes').hidden = true; sugestoesAtuais = []; sugestaoFoco = -1; }

function buscarSugestoes(texto) {
  const termos = normal(texto).split(' ').filter(Boolean);
  if (!termos.length || normal(texto).length < 2) return fecharSugestoes();
  const res = [];
  for (const p of pacientes()) {
    if (termos.every(t => p.norm.includes(t))) res.push(p);
    if (res.length >= 8) break;
  }
  sugestoesAtuais = res;
  sugestaoFoco = -1;
  const ul = $('#sugestoes');
  ul.innerHTML = res.map((p, i) => `<li data-i="${i}"><span>${esc(p.nome)}</span><small>${p.ultimo.prontuario ? 'Pront. ' + esc(p.ultimo.prontuario) + ' · ' : ''}${dataBR(p.ultimo.data)}</small></li>`).join('');
  ul.hidden = !res.length;
}

function iniciarAtendimento() {
  const f = $('#form-atendimento');
  f.data.value = hoje();

  $('#fichas-exames').addEventListener('click', e => {
    const b = e.target.closest('button[data-id]');
    if (!b) return;
    const id = +b.dataset.id;
    examesSelecionados.has(id) ? examesSelecionados.delete(id) : examesSelecionados.set(id, null);
    b.setAttribute('aria-pressed', examesSelecionados.has(id));
    renderOlhos();
  });

  // Tocar no olho já escolhido desmarca (o campo é opcional).
  $('#olhos-exames').addEventListener('click', e => {
    const b = e.target.closest('button[data-olho]');
    if (!b) return;
    const id = +b.closest('[data-id]').dataset.id;
    examesSelecionados.set(id, examesSelecionados.get(id) === b.dataset.olho ? null : b.dataset.olho);
    renderOlhos();
  });

  $('#fichas-obs').innerHTML = OBS_RAPIDAS.map(o => `<button type="button">${esc(o)}</button>`).join('');
  $('#fichas-obs').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const atual = f.obs.value.trim();
    f.obs.value = atual ? `${atual} - ${b.textContent}` : b.textContent;
  });

  f.paciente.addEventListener('input', debounce(() => buscarSugestoes(f.paciente.value), 120));
  f.paciente.addEventListener('keydown', e => {
    const ul = $('#sugestoes');
    if (ul.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sugestaoFoco = (sugestaoFoco + (e.key === 'ArrowDown' ? 1 : -1) + sugestoesAtuais.length) % sugestoesAtuais.length;
      $$('li', ul).forEach((li, i) => li.classList.toggle('foco', i === sugestaoFoco));
    } else if (e.key === 'Enter' && sugestaoFoco >= 0) {
      e.preventDefault();
      escolherPaciente(sugestoesAtuais[sugestaoFoco]);
    } else if (e.key === 'Escape') fecharSugestoes();
  });
  f.paciente.addEventListener('blur', () => setTimeout(fecharSugestoes, 150));
  $('#sugestoes').addEventListener('mousedown', e => {
    const li = e.target.closest('li[data-i]');
    if (li) { e.preventDefault(); escolherPaciente(sugestoesAtuais[+li.dataset.i]); }
  });

  f.prontuario.addEventListener('change', () => {
    const p = pacientePorProntuario(f.prontuario.value);
    if (p && !f.paciente.value.trim()) escolherPaciente(p);
    else mostrarHistorico(p && normal(f.paciente.value) === p.norm ? p : null);
  });

  f.data.addEventListener('change', renderListaDia);

  f.addEventListener('reset', () => {
    const data = f.data.value; // o evento dispara antes de o navegador limpar os campos
    setTimeout(() => {
      examesSelecionados.clear();
      renderFichasExames();
      $('#historico-paciente').hidden = true;
      fecharSugestoes();
      f.data.value = data || hoje();
    });
  });

  f.addEventListener('submit', async e => {
    e.preventDefault();
    if (!examesSelecionados.size) return aviso('Selecione pelo menos um exame.');
    const base = {
      data: f.data.value,
      paciente: f.paciente.value.trim().replace(/\s+/g, ' '),
      prontuario: f.prontuario.value.trim(),
      medico: +f.medico.value,
      convenio: +f.convenio.value,
      obs: f.obs.value.trim()
    };
    const novos = [...examesSelecionados].map(([exame, olho]) => ({ ...base, exame, olho }));

    const repetidos = novos.filter(n => dados.lancamentos.some(r =>
      r.data === n.data && r.exame === n.exame && (r.olho || null) === n.olho && chavePaciente(r) === chavePaciente(n)));
    if (repetidos.length && !confirm(`Já existe registro de ${repetidos.map(r => nomeDe('exames', r.exame)).join(', ')} para este paciente nesta data. Salvar mesmo assim?`)) return;

    const botao = f.querySelector('[type=submit]');
    botao.disabled = true;
    try {
      await gravar('lancamentos', novos);
    } finally {
      botao.disabled = false;
    }
    dados.lancamentos.push(...novos);
    aposMudanca();
    const data = f.data.value;
    f.reset();
    setTimeout(() => { f.data.value = data; renderListaDia(); f.prontuario.focus(); });
    aviso(`${novos.length} exame(s) registrado(s) para ${base.paciente}.`, 'Desfazer', async () => {
      await apagar('lancamentos', novos.map(n => n.id));
      const ids = new Set(novos.map(n => n.id));
      dados.lancamentos = dados.lancamentos.filter(r => !ids.has(r.id));
      aposMudanca();
      aviso('Registro desfeito.');
    }, 8000);
  });

  ligarCliquesTabela($('#lista-dia'));
}

/* ---------- Edição de um registro ---------- */

let emEdicao = null;

function abrirEdicao(id) {
  const r = dados.lancamentos.find(x => x.id === id);
  if (!r) return;
  emEdicao = r;
  const f = $('#form-editar');
  preencherSelect(f.exame, 'exames', { incluirInativos: true });
  preencherSelect(f.medico, 'medicos', { incluirInativos: true });
  preencherSelect(f.convenio, 'convenios', { incluirInativos: true });
  f.data.value = r.data;
  f.prontuario.value = r.prontuario || '';
  f.paciente.value = r.paciente || '';
  f.exame.value = r.exame;
  f.medico.value = r.medico;
  f.convenio.value = r.convenio;
  f.olho.value = r.olho || '';
  f.obs.value = r.obs || '';
  $('#dialogo-editar').showModal();
}

function iniciarEdicao() {
  const dlg = $('#dialogo-editar'), f = $('#form-editar');
  $('#cancelar-edicao').onclick = () => dlg.close();
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const r = emEdicao;
    const alterado = {
      id: r.id,
      data: f.data.value,
      prontuario: f.prontuario.value.trim(),
      paciente: f.paciente.value.trim().replace(/\s+/g, ' '),
      exame: +f.exame.value,
      medico: +f.medico.value,
      convenio: +f.convenio.value,
      olho: olhoValido(f.olho.value),
      obs: f.obs.value.trim()
    };
    await gravar('lancamentos', [alterado]);
    Object.assign(r, alterado);
    dlg.close();
    aposMudanca();
    aviso('Registro atualizado.');
  });
  $('#excluir-registro').onclick = async () => {
    const r = emEdicao;
    await apagar('lancamentos', [r.id]);
    dados.lancamentos = dados.lancamentos.filter(x => x !== r);
    dlg.close();
    aposMudanca();
    aviso('Registro excluído.', 'Desfazer', async () => {
      const copia = { ...r, id: null }; // volta como registro novo
      await gravar('lancamentos', [copia]);
      dados.lancamentos.push(copia);
      aposMudanca();
    }, 8000);
  };
}

/* ---------- Aba: Registros ---------- */

let filtrados = [], mostrando = POR_PAGINA;

function aplicarFiltros() {
  const f = $('#filtros');
  const termos = normal(f.busca.value).split(' ').filter(Boolean);
  const obs = normal(f.obs.value);
  const de = f.de.value, ate = f.ate.value;
  const ex = +f.exame.value || null, med = +f.medico.value || null, conv = +f.convenio.value || null;
  const olho = f.olho.value; // '' = todos, 'nenhum' = sem informação
  filtrados = dados.lancamentos.filter(r =>
    (!de || r.data >= de) && (!ate || r.data <= ate) &&
    (!ex || r.exame === ex) && (!med || r.medico === med) && (!conv || r.convenio === conv) &&
    (!olho || (olho === 'nenhum' ? !r.olho : r.olho === olho)) &&
    (!obs || normal(r.obs).includes(obs)) &&
    (!termos.length || termos.every(t => normal(r.paciente).includes(t) || normal(r.prontuario).includes(t)))
  ).sort(ordenarRecentes);
  mostrando = POR_PAGINA;
  renderRegistros();
}

function renderRegistros() {
  $('#contagem-registros').textContent = `${num(filtrados.length)} registro(s)` +
    (filtrados.length > mostrando ? ` — mostrando os ${num(mostrando)} mais recentes` : '');
  $('#lista-registros').innerHTML = tabela(filtrados.slice(0, mostrando));
  $('#mostrar-mais').hidden = filtrados.length <= mostrando;
}

function iniciarRegistros() {
  const f = $('#filtros');
  f.addEventListener('input', debounce(aplicarFiltros, 200));
  f.addEventListener('submit', e => e.preventDefault());
  $('#limpar-filtros').onclick = () => { f.reset(); aplicarFiltros(); };
  $('#mostrar-mais').onclick = () => { mostrando += POR_PAGINA; renderRegistros(); };
  $('#exportar-filtrados').onclick = () => {
    if (!filtrados.length) return aviso('Nenhum registro para exportar.');
    exportarExcel(filtrados, `exames-filtrados-${hoje()}.xlsx`);
  };
  ligarCliquesTabela($('#lista-registros'));
}

/* ---------- Aba: Relatórios ---------- */

function definirPeriodo(p) {
  const d = new Date(), y = d.getFullYear(), m = d.getMonth();
  const intervalos = {
    'hoje': [hoje(), hoje()],
    'mes': [isoLocal(new Date(y, m, 1)), isoLocal(new Date(y, m + 1, 0))],
    'mes-passado': [isoLocal(new Date(y, m - 1, 1)), isoLocal(new Date(y, m, 0))],
    'ano': [`${y}-01-01`, `${y}-12-31`],
    '12m': [isoLocal(new Date(y, m - 11, 1)), isoLocal(new Date(y, m + 1, 0))],
    'tudo': ['', '']
  };
  [$('#rel-de').value, $('#rel-ate').value] = intervalos[p];
  $$('#periodos button').forEach(b => b.classList.toggle('ativa', b.dataset.p === p));
}

function dadosRelatorio() {
  const de = $('#rel-de').value, ate = $('#rel-ate').value;
  const med = +$('#rel-medico').value || null, conv = +$('#rel-convenio').value || null;
  return dados.lancamentos.filter(r =>
    (!de || r.data >= de) && (!ate || r.data <= ate) && (!med || r.medico === med) && (!conv || r.convenio === conv));
}

function contar(lista, chave) {
  const m = new Map();
  for (const r of lista) { const k = chave(r); m.set(k, (m.get(k) || 0) + 1); }
  return m;
}

function agrupamentos(lista) {
  const ordenar = (m, tipo) => [...m.entries()].map(([id, n]) => ({ nome: nomeDe(tipo, id), n })).sort((a, b) => b.n - a.n);
  const datas = lista.map(r => r.data).sort();
  const anos = datas.length && (+datas[datas.length - 1].slice(0, 4) - +datas[0].slice(0, 4));
  const porAno = anos >= 2;
  const tempo = [...contar(lista, r => porAno ? r.data.slice(0, 4) : r.data.slice(0, 7)).entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, n]) => ({ nome: porAno ? k : mesBR(k), n }));
  return {
    exames: ordenar(contar(lista, r => r.exame), 'exames'),
    medicos: ordenar(contar(lista, r => r.medico), 'medicos'),
    convenios: ordenar(contar(lista, r => r.convenio), 'convenios'),
    tempo, porAno
  };
}

function barras(itens, total) {
  if (!itens.length) return '<p class="vazio">Sem dados no período.</p>';
  const max = Math.max(...itens.map(i => i.n));
  return `<div class="barras">${itens.map(i => `<div class="barra-linha">
      <span class="nome" title="${esc(i.nome)}">${esc(i.nome)}</span>
      <span class="n">${num(i.n)}<small>${total ? Math.round(i.n / total * 100) + '%' : ''}</small></span>
      <span class="trilho"><i style="width:${(i.n / max * 100).toFixed(1)}%"></i></span>
    </div>`).join('')}</div>`;
}

function renderRelatorio() {
  const lista = dadosRelatorio();
  const g = agrupamentos(lista);
  const pacientesUnicos = new Set(lista.map(chavePaciente)).size;
  const atendimentos = new Set(lista.map(r => r.data + '|' + chavePaciente(r))).size;
  const dias = new Set(lista.map(r => r.data)).size;
  $('#indicadores').innerHTML = [
    ['Exames realizados', lista.length],
    ['Atendimentos', atendimentos],
    ['Pacientes diferentes', pacientesUnicos],
    ['Dias com atendimento', dias]
  ].map(([r, v]) => `<div class="indicador"><div class="valor">${num(v)}</div><div class="rotulo">${r}</div></div>`).join('');
  $('#rel-exames').innerHTML = barras(g.exames, lista.length);
  $('#rel-medicos').innerHTML = barras(g.medicos, lista.length);
  $('#rel-convenios').innerHTML = barras(g.convenios, lista.length);
  $('#rel-meses').innerHTML = barras(g.tempo, 0);
  $('#rel-meses').previousElementSibling.textContent = g.porAno ? 'Por ano' : 'Por mês';
}

function iniciarRelatorios() {
  $('#periodos').addEventListener('click', e => {
    const b = e.target.closest('button[data-p]');
    if (b) { definirPeriodo(b.dataset.p); renderRelatorio(); }
  });
  for (const id of ['#rel-de', '#rel-ate']) $(id).addEventListener('change', () => {
    $$('#periodos button').forEach(b => b.classList.remove('ativa'));
    renderRelatorio();
  });
  for (const id of ['#rel-medico', '#rel-convenio']) $(id).addEventListener('change', renderRelatorio);
  definirPeriodo('mes');
  $('#exportar-relatorio').onclick = exportarRelatorio;
}

/* ---------- Aba: Ajustes ---------- */

let tipoCadastro = 'exames';

function renderCadastro() {
  const { total } = usos(tipoCadastro);
  const lista = [...dados[tipoCadastro]].sort((a, b) => a.id - b.id);
  $('#lista-cadastro').innerHTML = lista.map(i => `<div class="item-cadastro${i.ativo === false ? ' inativo' : ''}" data-id="${i.id}">
      <span class="cod">${i.id}</span>
      <input type="text" value="${esc(i.nome)}" aria-label="Nome">
      <span class="uso">${num(total.get(i.id) || 0)} registro(s)</span>
      <label class="chave"><input type="checkbox" ${i.ativo !== false ? 'checked' : ''}> Ativo</label>
    </div>`).join('') || '<p class="vazio">Nenhum item cadastrado.</p>';
}

function renderResumoDados() {
  const n = dados.lancamentos.length;
  const datas = dados.lancamentos.map(r => r.data).filter(Boolean).sort();
  $('#resumo-dados').textContent = n
    ? `${num(n)} registros no banco online, de ${dataBR(datas[0])} a ${dataBR(datas[datas.length - 1])}.`
    : 'Nenhum registro guardado ainda.';
  const ub = meta.get('ultimoBackup');
  $('#usuario-email').textContent = usuarioEmail;
  $('#ultimo-backup').textContent = ub ? `Última cópia: ${new Date(ub).toLocaleString('pt-BR')}` : 'Nenhuma cópia feita ainda.';
}

function iniciarAjustes() {
  $('#tipos-cadastro').addEventListener('click', e => {
    const b = e.target.closest('button[data-t]');
    if (!b) return;
    tipoCadastro = b.dataset.t;
    $$('#tipos-cadastro button').forEach(x => x.classList.toggle('ativa', x === b));
    $('#form-novo-cadastro').nome.placeholder = `Nome do novo ${TIPOS[tipoCadastro].singular}`;
    renderCadastro();
  });

  $('#form-novo-cadastro').addEventListener('submit', async e => {
    e.preventDefault();
    const nome = e.target.nome.value.trim();
    if (!nome) return;
    if (dados[tipoCadastro].some(i => normal(i.nome) === normal(nome))) return aviso('Já existe um item com esse nome.');
    const item = { id: Math.max(0, ...dados[tipoCadastro].map(i => i.id)) + 1, nome, ativo: true };
    await gravar(tipoCadastro, [item]);
    dados[tipoCadastro].push(item);
    e.target.reset();
    aposMudanca();
    aviso(`“${nome}” adicionado.`);
  });

  const lista = $('#lista-cadastro');
  lista.addEventListener('change', async e => {
    const linha = e.target.closest('.item-cadastro');
    if (!linha) return;
    const item = mapa(tipoCadastro).get(+linha.dataset.id);
    if (e.target.type === 'checkbox') item.ativo = e.target.checked;
    else {
      const nome = e.target.value.trim();
      if (!nome) { e.target.value = item.nome; return; }
      item.nome = nome;
    }
    await gravar(tipoCadastro, [item]);
    aposMudanca();
    aviso('Cadastro atualizado.');
  });

  $('#arquivo-planilha').addEventListener('change', async e => {
    const arq = e.target.files[0];
    e.target.value = '';
    if (arq) await importarPlanilha(arq);
  });
  $('#arquivo-backup').addEventListener('change', async e => {
    const arq = e.target.files[0];
    e.target.value = '';
    if (arq) await restaurarBackup(arq);
  });
  $('#fazer-backup').onclick = fazerBackup;
  $('#exportar-tudo').onclick = () => exportarExcel([...dados.lancamentos].sort(ordenarRecentes).reverse(), `controle-de-exames-${hoje()}.xlsx`);
}

/* ---------- Importação da planilha original ---------- */

function dataDaCelula(v) {
  if (typeof v === 'number') {
    const d = XLSX.SSF.parse_date_code(v);
    return d ? `${d.y}-${pad(d.m)}-${pad(d.d)}` : '';
  }
  const m = String(v ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return '';
  const ano = m[3].length === 2 ? '20' + m[3] : m[3];
  return `${ano}-${pad(m[2])}-${pad(m[1])}`;
}

const texto = v => v == null ? '' : String(v).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

function lerPlanilha(arquivoBuffer, incluirSF) {
  const wb = XLSX.read(arquivoBuffer, { type: 'array' });
  const aba = nome => {
    const k = wb.SheetNames.find(n => normal(n) === nome);
    return k ? XLSX.utils.sheet_to_json(wb.Sheets[k], { header: 1, raw: true, defval: null }) : null;
  };
  const cadastros = {};
  const fontes = { exames: 'exame', medicos: 'medicos', convenios: 'convenios' };
  for (const [tipo, nomeAba] of Object.entries(fontes)) {
    const linhas = aba(nomeAba);
    if (!linhas) throw new Error(`A aba “${nomeAba}” não foi encontrada na planilha.`);
    cadastros[tipo] = linhas.slice(1)
      .filter(l => Number.isFinite(+l[0]) && l[0] !== null && texto(l[1]))
      .map(l => ({ id: +l[0], nome: texto(l[1]), ativo: true }));
  }

  const lanc = [];
  let ignorados = 0;
  const lerLancamentos = (linhas, sufixoObs) => {
    // Planilhas exportadas pelo app trazem a coluna "Olho" logo depois de "Obs.".
    const colOlho = (linhas[0] || []).findIndex(h => normal(h) === 'olho');
    for (const l of linhas.slice(1)) {
      const paciente = texto(l[0]);
      const prontuario = texto(l[4]);
      const data = dataDaCelula(l[1]);
      const exame = typeof l[2] === 'number' ? Math.round(l[2]) : parseInt(l[2], 10);
      if (!l.some(v => v != null && !String(v).startsWith('='))) continue; // linha vazia
      if ((!paciente && !prontuario) || !data || !Number.isFinite(exame)) { ignorados++; continue; }
      const obs = [texto(l[9]), colOlho === 10 ? '' : texto(l[10]), sufixoObs].filter(Boolean).join(' - ');
      lanc.push({
        paciente, prontuario, data, exame,
        olho: colOlho >= 0 ? olhoValido(texto(l[colOlho]).toUpperCase()) : null,
        medico: parseInt(l[5], 10) || null,
        convenio: parseInt(l[7], 10) || null,
        obs
      });
    }
  };
  const principal = aba('lancamentos');
  if (!principal) throw new Error('A aba “Lançamentos” não foi encontrada na planilha.');
  lerLancamentos(principal, '');
  const sf = incluirSF && aba('sao francisco - antigas');
  if (sf) lerLancamentos(sf, 'São Francisco (antigas)');

  // Códigos usados nos lançamentos que não existam no cadastro viram itens "Código N".
  for (const [tipo, { campo }] of Object.entries(TIPOS)) {
    const ids = new Set(cadastros[tipo].map(i => i.id));
    for (const r of lanc) {
      if (r[campo] != null && !ids.has(r[campo])) {
        ids.add(r[campo]);
        cadastros[tipo].push({ id: r[campo], nome: `Código ${r[campo]}`, ativo: false });
      }
    }
  }
  lanc.sort((a, b) => a.data.localeCompare(b.data));
  lanc.forEach((r, i) => { r.id = i + 1; });
  return { ...cadastros, lancamentos: lanc, ignorados };
}

async function importarPlanilha(arq) {
  aviso('Lendo a planilha…', null, null, 0);
  try {
    const novo = lerPlanilha(await arq.arrayBuffer(), $('#incluir-sf').checked);
    $('#toast').hidden = true;
    const msg = `Foram encontrados ${num(novo.lancamentos.length)} registros, ${novo.exames.length} exames, ` +
      `${novo.medicos.length} médicos e ${novo.convenios.length} convênios.` +
      (dados.lancamentos.length ? `\n\nATENÇÃO: isso substitui os ${num(dados.lancamentos.length)} registros que estão no app hoje.` : '') +
      '\n\nImportar?';
    if (!confirm(msg)) return;
    aviso('Importando…', null, null, 0);
    await substituirTudo(novo, (feitos, total) => aviso(`Enviando registros… ${num(feitos)} de ${num(total)}`, null, null, 0));
    aposMudanca();
    aviso(`Importação concluída: ${num(novo.lancamentos.length)} registros.` +
      (novo.ignorados ? ` ${novo.ignorados} linha(s) incompleta(s) ignorada(s).` : ''), null, null, 8000);
  } catch (err) {
    console.error(err);
    aviso('Não foi possível importar: ' + err.message, null, null, 10000);
  }
}

/* ---------- Cópia de segurança ---------- */

async function fazerBackup() {
  const conteudo = JSON.stringify({
    app: 'controle-exames', versao: 1, criadoEm: new Date().toISOString(),
    exames: dados.exames, medicos: dados.medicos, convenios: dados.convenios, lancamentos: dados.lancamentos
  });
  baixar(`backup-exames-${hoje()}.json`, conteudo, 'application/json');
  meta.set('ultimoBackup', new Date().toISOString());
  renderResumoDados();
}

async function restaurarBackup(arq) {
  try {
    const b = JSON.parse(await arq.text());
    if (b.app !== 'controle-exames' || !Array.isArray(b.lancamentos)) throw new Error('arquivo não é uma cópia deste app.');
    if (!confirm(`Cópia de ${new Date(b.criadoEm).toLocaleString('pt-BR')} com ${num(b.lancamentos.length)} registros.\n\n` +
      `Isso substitui os ${num(dados.lancamentos.length)} registros atuais. Restaurar?`)) return;
    aviso('Restaurando…', null, null, 0);
    await substituirTudo(b, (feitos, total) => aviso(`Enviando registros… ${num(feitos)} de ${num(total)}`, null, null, 0));
    aposMudanca();
    aviso('Cópia restaurada.');
  } catch (err) {
    aviso('Não foi possível restaurar: ' + err.message, null, null, 10000);
  }
}

function lembrarBackup() {
  if (dados.lancamentos.length < 1) return;
  const ub = meta.get('ultimoBackup') ? new Date(meta.get('ultimoBackup')) : null;
  const dias = ub ? Math.floor((Date.now() - ub) / 864e5) : Infinity;
  if (dias >= DIAS_LEMBRETE_BACKUP) {
    aviso(ub ? `Sua última cópia de segurança foi há ${dias} dias.` : 'Você ainda não fez uma cópia de segurança.',
      'Fazer agora', fazerBackup, 12000);
  }
}

/* ---------- Exportação para Excel ---------- */

const serialExcel = iso => (Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 864e5;

function folha(linhas, larguras, colunaData = -1) {
  const ws = XLSX.utils.aoa_to_sheet(linhas);
  ws['!cols'] = larguras.map(wch => ({ wch }));
  if (colunaData >= 0) {
    for (let i = 1; i < linhas.length; i++) {
      const c = ws[XLSX.utils.encode_cell({ r: i, c: colunaData })];
      if (c && c.t === 'n') c.z = 'dd/mm/yyyy';
    }
  }
  return ws;
}

function exportarExcel(lista, nomeArquivo) {
  const wb = XLSX.utils.book_new();
  const cab = ['Nome do Paciente', 'Data do Exame', 'Código do Exame', 'Nome do Exame', 'Prontuário',
    'Código do Médico', 'Nome do Médico', 'Código do Convênio', 'Nome do Convênio', 'Obs.', 'Olho'];
  const linhas = [cab, ...lista.map(r => [
    r.paciente, r.data ? serialExcel(r.data) : '', r.exame, nomeDe('exames', r.exame), r.prontuario,
    r.medico, nomeDe('medicos', r.medico), r.convenio, nomeDe('convenios', r.convenio), r.obs || '', r.olho || ''
  ])];
  XLSX.utils.book_append_sheet(wb, folha(linhas, [36, 12, 9, 30, 14, 9, 24, 9, 26, 30, 6], 1), 'Lançamentos');
  const cad = (tipo, titulo) => XLSX.utils.book_append_sheet(wb,
    folha([['Código', titulo], ...[...dados[tipo]].sort((a, b) => a.id - b.id).map(i => [i.id, i.nome])], [8, 40]),
    { exames: 'Exame', medicos: 'Médicos', convenios: 'Convênios' }[tipo]);
  cad('exames', 'Nome do Exame');
  cad('medicos', 'Nome do Médico');
  cad('convenios', 'Nome do Convênio');
  XLSX.writeFile(wb, nomeArquivo);
}

function exportarRelatorio() {
  const lista = dadosRelatorio();
  if (!lista.length) return aviso('Nenhum registro no período.');
  const g = agrupamentos(lista);
  const de = $('#rel-de').value, ate = $('#rel-ate').value;
  const wb = XLSX.utils.book_new();
  const resumo = (itens, titulo) => folha([[titulo, 'Quantidade', '%'],
    ...itens.map(i => [i.nome, i.n, +(i.n / lista.length * 100).toFixed(1)]), ['Total', lista.length, 100]], [40, 12, 8]);
  XLSX.utils.book_append_sheet(wb, resumo(g.exames, 'Exame'), 'Por exame');
  XLSX.utils.book_append_sheet(wb, resumo(g.medicos, 'Médico solicitante'), 'Por médico');
  XLSX.utils.book_append_sheet(wb, resumo(g.convenios, 'Convênio'), 'Por convênio');
  XLSX.utils.book_append_sheet(wb, folha([[g.porAno ? 'Ano' : 'Mês', 'Quantidade'], ...g.tempo.map(i => [i.nome, i.n])], [14, 12]),
    g.porAno ? 'Por ano' : 'Por mês');

  // Tabela cruzada convênio × exame (útil para faturamento).
  const exs = g.exames.map(e => e.nome);
  const cruz = new Map();
  for (const r of lista) {
    const c = nomeDe('convenios', r.convenio);
    if (!cruz.has(c)) cruz.set(c, new Map());
    const m = cruz.get(c), e = nomeDe('exames', r.exame);
    m.set(e, (m.get(e) || 0) + 1);
  }
  const linhasCruz = [['Convênio \\ Exame', ...exs, 'Total'],
    ...g.convenios.map(c => [c.nome, ...exs.map(e => cruz.get(c.nome).get(e) || 0), c.n])];
  XLSX.utils.book_append_sheet(wb, folha(linhasCruz, [30, ...exs.map(() => 14), 10]), 'Convênio x Exame');

  const periodo = de || ate ? `${de || 'inicio'}_a_${ate || 'hoje'}` : 'todo-periodo';
  XLSX.writeFile(wb, `relatorio-exames-${periodo}.xlsx`);
}

/* ---------- Navegação e atualização das telas ---------- */

let abaAtual = 'atendimento';

function irPara(aba) {
  abaAtual = aba;
  $$('#abas button').forEach(b => b.classList.toggle('ativa', b.dataset.aba === aba));
  $$('.aba').forEach(s => s.classList.toggle('ativa', s.id === 'aba-' + aba));
  renderAba();
  window.scrollTo(0, 0);
}

function renderAba() {
  if (abaAtual === 'atendimento') { renderFichasExames(); renderListaDia(); }
  if (abaAtual === 'registros') aplicarFiltros();
  if (abaAtual === 'relatorios') renderRelatorio();
  if (abaAtual === 'ajustes') { renderCadastro(); renderResumoDados(); }
}

function aposMudanca() {
  invalidar();
  atualizarSelects();
  $('#aviso-vazio').hidden = dados.lancamentos.length > 0 || dados.exames.length > 0;
  renderAba();
}

function registrarServiceWorker() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js');
}

/* ---------- Login ---------- */

let usuarioEmail = '';
let interfaceIniciada = false;

function mensagemEntrada(texto, erro = false) {
  const el = $('#mensagem-entrada');
  el.textContent = texto;
  el.classList.toggle('erro', erro);
}

function mostrarEntrada(modo) {
  document.body.classList.add('fora');
  $('#form-login').hidden = modo !== 'login';
  $('#form-nova-senha').hidden = modo !== 'nova-senha';
  $('#carregando').hidden = modo !== 'carregando';
  if (modo === 'login') setTimeout(() => $('#form-login').email.focus());
}

const traduzirErro = msg =>
  /invalid login credentials/i.test(msg) ? 'E-mail ou senha incorretos.' :
  /email not confirmed/i.test(msg) ? 'Este e-mail ainda não foi confirmado.' :
  /failed to fetch|network/i.test(msg) ? 'Sem conexão com a internet.' :
  /rate limit|security purposes/i.test(msg) ? 'Muitas tentativas. Aguarde um minuto e tente de novo.' :
  /should be different/i.test(msg) ? 'A nova senha precisa ser diferente da atual.' : msg;

async function entrarNoApp(sessao) {
  usuarioEmail = sessao.user.email;
  mostrarEntrada('carregando');
  mensagemEntrada('');
  try {
    await carregar();
  } catch (err) {
    mostrarEntrada('login');
    mensagemEntrada('Não foi possível carregar os dados: ' + traduzirErro(err.message), true);
    return;
  }
  document.body.classList.remove('fora');
  if (!interfaceIniciada) {
    interfaceIniciada = true;
    iniciarAtendimento();
    iniciarEdicao();
    iniciarRegistros();
    iniciarRelatorios();
    iniciarAjustes();
  }
  aposMudanca();
  setTimeout(lembrarBackup, 1500);
}

function iniciarLogin() {
  const fl = $('#form-login'), fn = $('#form-nova-senha');

  fl.addEventListener('submit', async e => {
    e.preventDefault();
    mensagemEntrada('Entrando…');
    const { data, error } = await sb.auth.signInWithPassword({ email: fl.email.value.trim(), password: fl.senha.value });
    if (error) return mensagemEntrada(traduzirErro(error.message), true);
    fl.senha.value = '';
    entrarNoApp(data.session);
  });

  $('#esqueci').onclick = async () => {
    const email = fl.email.value.trim();
    if (!email) return mensagemEntrada('Digite seu e-mail acima e toque de novo em “Esqueci minha senha”.', true);
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    mensagemEntrada(error ? traduzirErro(error.message) : 'Se o e-mail estiver cadastrado, você receberá um link para criar uma nova senha.', !!error);
  };

  fn.addEventListener('submit', async e => {
    e.preventDefault();
    if (fn.senha.value !== fn.senha2.value) return mensagemEntrada('As duas senhas não são iguais.', true);
    const { data, error } = await sb.auth.updateUser({ password: fn.senha.value });
    if (error) return mensagemEntrada(traduzirErro(error.message), true);
    fn.reset();
    history.replaceState(null, '', location.pathname);
    aviso('Senha alterada.');
    entrarNoApp({ user: data.user });
  });

  $('#sair').onclick = async () => {
    await sb.auth.signOut();
    Object.assign(dados, { exames: [], medicos: [], convenios: [], lancamentos: [] });
    invalidar();
    mensagemEntrada('');
    mostrarEntrada('login');
  };
  $('#trocar-senha').onclick = () => {
    mensagemEntrada('');
    mostrarEntrada('nova-senha');
  };
}

/* ---------- Início ---------- */

async function iniciar() {
  registrarServiceWorker();
  if (!window.CONFIG || !/^https?:\/\//.test(CONFIG.supabaseUrl)) {
    mostrarEntrada('');
    return mensagemEntrada('O app ainda não foi configurado: preencha o arquivo config.js com os dados do Supabase.', true);
  }
  sb = supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseChave);
  iniciarLogin();

  $('#abas').addEventListener('click', e => {
    const b = e.target.closest('button[data-aba]');
    if (b) irPara(b.dataset.aba);
  });
  document.addEventListener('click', e => {
    const a = e.target.closest('[data-ir]');
    if (a) { e.preventDefault(); irPara(a.dataset.ir); }
  });

  // Link de "esqueci minha senha" recebido por e-mail.
  let recuperando = /type=recovery/.test(location.hash);
  sb.auth.onAuthStateChange(evento => {
    if (evento === 'PASSWORD_RECOVERY') {
      recuperando = true;
      mensagemEntrada('');
      mostrarEntrada('nova-senha');
    }
  });

  const { data: { session } } = await sb.auth.getSession();
  if (recuperando) mostrarEntrada('nova-senha');
  else if (session) entrarNoApp(session);
  else mostrarEntrada('login');

  // Ao voltar para o app depois de um tempo, busca o que foi registrado em outros lugares.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || document.body.classList.contains('fora')) return;
    if (Date.now() - carregadoEm < 5 * 60 * 1000 || $('#dialogo-editar').open) return;
    try { await carregar(); aposMudanca(); } catch { /* tenta de novo na próxima vez */ }
  });
}

// Qualquer falha ao gravar (ex.: internet caiu) aparece como aviso na tela.
window.addEventListener('unhandledrejection', e => {
  console.error(e.reason);
  aviso('Não foi possível concluir: ' + traduzirErro(e.reason?.message || String(e.reason)) + ' Nada foi perdido do que já estava salvo; tente de novo.', null, null, 10000);
});

iniciar().catch(err => {
  console.error(err);
  mostrarEntrada('login');
  mensagemEntrada('Erro ao iniciar o app: ' + err.message, true);
});
