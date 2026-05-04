// ════════════════════════════════════════════════════════════
//  MA PAIE - APPLICATION UNIVERSELLE PARAMÉTRABLE v2.0
// ════════════════════════════════════════════════════════════

// ── CONSTANTES ──
const MONTHS=['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
const MS=['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc'];

// Calcule le dernier jour ouvré du mois (pour date de virement)
function lastWorkDay(year,month){
  let d=new Date(year,month+1,0);
  while(d.getDay()===0||d.getDay()===6)d.setDate(d.getDate()-1);
  return d;
}
function getPDdyn(year){
  return Array(12).fill(0).map((_,i)=>{
    const d=new Date(year,i+1,0);
    const dd=String(d.getDate()).padStart(2,'0');
    const mm=String(d.getMonth()+1).padStart(2,'0');
    return `${dd}/${mm}/${year}`;
  });
}

// ── PARAMÈTRES PAR DÉFAUT ──
// salType: 'fixe' | 'commission' | 'fixe_comm' | 'custom'
// paliers: tableau de {seuil, taux} - le palier démarre à seuil, taux en %
const SAL_DEFAULT={
  prenom:'',
  poste:'',
  salType:'fixe_comm',     // type de rémunération
  fixe:1830,               // salaire fixe brut mensuel
  chargesPct:23.4,         // % charges sociales
  defaultPAS:7,            // % PAS par défaut
  franchise:6150,          // CA exonéré avant commission (0 si pas applicable)
  paliers:[                // paliers progressifs
    {seuil:6150, taux:22},
    {seuil:10050, taux:24}
  ]
};

// ── STORAGE ──
function ld(k,def){try{const s=localStorage.getItem(k);if(s)return JSON.parse(s);}catch(e){}return def;}
function sv(k,v){try{localStorage.setItem(k,JSON.stringify(v));}catch(e){}}

// Migration depuis ancienne version
function migrateOld(){
  const old=ld('mp_sal',null);
  if(old && old.taux1!==undefined && !old.paliers){
    old.paliers=[
      {seuil:old.seuil1||0, taux:old.taux1||0},
      {seuil:old.seuil2||0, taux:old.taux2||0}
    ];
    old.franchise=old.seuil1||0;
    old.salType='fixe_comm';
    sv('mp_sal',old);
  }
}
migrateOld();

let SAL=ld('mp_sal',{...SAL_DEFAULT});
// Garantir paliers/franchise présents
if(!SAL.paliers)SAL.paliers=[...SAL_DEFAULT.paliers];
if(SAL.franchise===undefined)SAL.franchise=SAL_DEFAULT.franchise;
if(!SAL.salType)SAL.salType='fixe_comm';

function emptyMonth(){return{ca:0,brut:0,netImposable:0,netAvantPAS:0,pas:0,tauxPAS:SAL.defaultPAS,netPaye:0,prime:0,cp:0,tr:0,note:''};}
function emptyYear(){return Array(12).fill(null).map(()=>emptyMonth());}

const currentY=new Date().getFullYear();
let years=ld('mp_years',{[currentY]:emptyYear()});
let deps=ld('mp_deps',[]);
let depNextId=ld('mp_depid',1);
let depEditId=null;
let compte=ld('mp_compte',{soldeInit:0,ops:[]});
let opNextId=ld('mp_opid',1);
let opType='dep';
let opFilter='all';
let OBJ_CA=ld('mp_obj',3000);
let currentYear=ld('mp_year',currentY);
let calcMode='ca';
let activeMonth=null;
let chartCA=null,chartNet=null,chartCourbe=null;

if(!years[currentYear])years[currentYear]=emptyYear();

function getData(){if(!years[currentYear])years[currentYear]=emptyYear();return years[currentYear];}
function setData(d){years[currentYear]=d;sv('mp_years',years);}
function getPD(){return getPDdyn(currentYear);}
function totalDeps(){return deps.reduce((s,d)=>s+d.amount,0);}
function fmt(n){if(n===null||n===undefined||isNaN(n))return'—';return new Intl.NumberFormat('fr-FR',{minimumFractionDigits:0,maximumFractionDigits:0}).format(n)+' €';}
function fmtN(n,d=2){return new Intl.NumberFormat('fr-FR',{minimumFractionDigits:d,maximumFractionDigits:d}).format(n);}
function fmtC(n){if(isNaN(n))return'—';return new Intl.NumberFormat('fr-FR',{minimumFractionDigits:2,maximumFractionDigits:2}).format(n)+' €';}
function fmtD(n){return n.toLocaleString('fr-FR')+' €';}
function fmtDate(d){const dt=new Date(d);return `${String(dt.getDate()).padStart(2,'0')}/${String(dt.getMonth()+1).padStart(2,'0')}/${dt.getFullYear()}`;}

// ════════════════════════════════════════════════════════════
//  MOTEUR DE CALCUL UNIVERSEL
// ════════════════════════════════════════════════════════════
// Calcule le brut à partir du CA selon le type de rémunération
function calcBrut(ca){
  const t=SAL.salType;
  if(t==='fixe')return SAL.fixe;
  // Commission (avec ou sans fixe)
  const fixe=t==='commission'?0:SAL.fixe;
  const baseCA=Math.max(ca-(SAL.franchise||0),0);
  if(baseCA<=0)return fixe;
  // Trier paliers par seuil croissant
  const ps=[...(SAL.paliers||[])].filter(p=>p.taux>0).sort((a,b)=>a.seuil-b.seuil);
  if(ps.length===0)return fixe;
  let comm=0;
  let detail=[];
  // Pour chaque palier : (min(CA, seuil_suivant) - max(CA_precedent, seuil_courant)) × taux
  for(let i=0;i<ps.length;i++){
    const p=ps[i];
    const next=ps[i+1];
    // Le palier i s'applique de p.seuil à next.seuil (ou infini)
    const debut=Math.max(p.seuil,SAL.franchise||0);
    const fin=next?next.seuil:Infinity;
    if(ca<=debut){detail.push({seuil:p.seuil,taux:p.taux,montant:0});continue;}
    const tranche=Math.min(ca,fin)-debut;
    const c=Math.max(tranche,0)*(p.taux/100);
    comm+=c;
    detail.push({seuil:p.seuil,taux:p.taux,montant:c,debut,fin:fin===Infinity?null:fin});
  }
  return{brut:fixe+comm,fixe,comm,detail,caComm:baseCA};
}

function calcSal(ca,tp){
  tp=tp??SAL.defaultPAS;
  const TC=SAL.chargesPct/100;
  const r=calcBrut(ca||0);
  // Si calcBrut renvoie un nombre (cas 'fixe'), normaliser
  let brut,fixe,comm=0,detail=[],caComm=0;
  if(typeof r==='number'){brut=r;fixe=r;}
  else{brut=r.brut;fixe=r.fixe;comm=r.comm;detail=r.detail;caComm=r.caComm;}
  const netAvant=brut*(1-TC);
  const pas=netAvant*(tp/100);
  const net=netAvant-pas;
  return{brut,fixe,comm,detail,caComm,netAvant,pas,net};
}

// CA nécessaire pour atteindre un net donné (recherche dichotomique)
function caFromNet(target,tp){
  tp=tp??SAL.defaultPAS;
  if(SAL.salType==='fixe'){return 0;} // pas de CA en mode fixe
  let lo=0,hi=200000;
  for(let i=0;i<60;i++){
    const mid=(lo+hi)/2;
    const r=calcSal(mid,tp);
    if(r.net<target)lo=mid;
    else hi=mid;
  }
  return Math.round((lo+hi)/2);
}

// Brut nécessaire pour un net donné (mode fixe)
function brutFromNet(target,tp){
  tp=tp??SAL.defaultPAS;
  const TC=SAL.chargesPct/100;
  // net = brut × (1-TC) × (1-tp/100)
  const facteur=(1-TC)*(1-tp/100);
  return facteur>0?Math.round(target/facteur):0;
}

// ════════════════════════════════════════════════════════════
//  NAVIGATION
// ════════════════════════════════════════════════════════════
const PAGES=['home','mois','compte','calc','params'];
function goPage(p){
  PAGES.forEach(id=>{
    const el=document.getElementById('page-'+id);
    const nav=document.getElementById('nav-'+id);
    if(el)el.classList.toggle('active',id===p);
    if(nav)nav.classList.toggle('active',id===p);
  });
  if(p==='home')renderHome();
  if(p==='compte')renderCompte();
  if(p==='calc'){document.getElementById('pas-rate').value=SAL.defaultPAS;runCalc();}
  if(p==='params')renderParams();
  if(p==='mois')renderMonthList();
  // Scroll en haut
  const pg=document.getElementById('page-'+p);
  if(pg)pg.scrollTop=0;
}

// ════════════════════════════════════════════════════════════
//  ONBOARDING
// ════════════════════════════════════════════════════════════
function checkOnboarding(){
  if(!SAL.prenom){
    document.getElementById('onboarding').style.display='flex';
  }
}
function finishOnboarding(){
  const prenom=document.getElementById('ob-prenom').value.trim();
  const poste=document.getElementById('ob-poste').value.trim();
  const preset=document.getElementById('ob-preset').value;
  const obj=parseFloat(document.getElementById('ob-obj').value)||3000;
  if(!prenom){document.getElementById('ob-prenom').focus();return;}
  SAL.prenom=prenom;
  if(poste)SAL.poste=poste;
  applyPreset(preset);
  OBJ_CA=obj;
  sv('mp_sal',SAL);sv('mp_obj',OBJ_CA);
  document.getElementById('onboarding').style.display='none';
  renderHome();
}

function applyPreset(preset){
  switch(preset){
    case 'fixe':
      SAL.salType='fixe';SAL.fixe=2000;SAL.franchise=0;SAL.paliers=[];
      break;
    case 'fixe_comm':
      SAL.salType='fixe_comm';SAL.fixe=1500;SAL.franchise=0;
      SAL.paliers=[{seuil:0,taux:5}];
      break;
    case 'fixe_2paliers':
      SAL.salType='fixe_comm';SAL.fixe=1830;SAL.franchise=6150;
      SAL.paliers=[{seuil:6150,taux:22},{seuil:10050,taux:24}];
      break;
    case 'commission':
      SAL.salType='commission';SAL.fixe=0;SAL.franchise=0;
      SAL.paliers=[{seuil:0,taux:10}];
      break;
    // 'custom' garde la config actuelle
  }
}

// ════════════════════════════════════════════════════════════
//  ANNÉES
// ════════════════════════════════════════════════════════════
function switchYear(y){
  currentYear=parseInt(y);sv('mp_year',currentYear);
  if(!years[currentYear])years[currentYear]=emptyYear();
  activeMonth=null;
  renderYearButtons();
  const sel=document.getElementById('year-selector');if(sel)sel.value=currentYear;
  document.getElementById('mois-list-view').style.display='block';
  document.getElementById('mois-form-view').style.display='none';
  renderMonthList();renderHome();
}
function addYear(){
  const input=prompt('Quelle année ajouter ?',new Date().getFullYear());
  if(!input)return;
  const newY=parseInt(input);
  if(isNaN(newY)||newY<2000||newY>2099){alert('Année invalide.');return;}
  if(years[newY]){alert(newY+' existe déjà.');switchYear(newY);return;}
  years[newY]=emptyYear();sv('mp_years',years);
  switchYear(newY);
}
function removeYear(y){
  if(Object.keys(years).length<=1){alert('Il faut garder au moins une année.');return;}
  if(!confirm('Supprimer '+y+' et toutes ses données ?'))return;
  delete years[y];sv('mp_years',years);
  const remaining=Object.keys(years).map(Number).sort();
  switchYear(remaining[remaining.length-1]);
}
function renderYearButtons(){
  const allYears=Object.keys(years).map(Number).sort();
  const homeWrap=document.getElementById('year-btns-home');
  if(homeWrap){
    homeWrap.innerHTML=allYears.map(y=>`<button onclick="switchYear(${y})" style="padding:7px 14px;border-radius:10px;font-family:'DM Mono',monospace;font-size:13px;font-weight:700;cursor:pointer;transition:all .2s;${y===currentYear?'border:2px solid var(--accent);background:rgba(245,200,66,.1);color:var(--accent);':'border:1px solid var(--border);background:transparent;color:var(--muted);'}">${y}</button>`).join('')+
    `<button onclick="addYear()" style="padding:7px 12px;border-radius:10px;border:1px dashed var(--border);background:transparent;color:var(--muted);font-family:'DM Mono',monospace;font-size:13px;cursor:pointer">+</button>`;
  }
  const sel=document.getElementById('year-selector');
  if(sel){
    sel.innerHTML=allYears.map(y=>`<option value="${y}" ${y===currentYear?'selected':''}>${y}</option>`).join('');
  }
}

// ════════════════════════════════════════════════════════════
//  ACCUEIL
// ════════════════════════════════════════════════════════════
function renderHome(){
  const d=getData();
  const charges=totalDeps();
  const totalCA=d.reduce((s,x)=>s+(x.ca||0),0);
  const totalNet=d.reduce((s,x)=>s+(x.netPaye||0),0);
  const totalPAS=d.reduce((s,x)=>s+(x.pas||0),0);
  const filled=d.filter(x=>x.netPaye>0);
  const avgNet=filled.length?Math.round(totalNet/filled.length):0;
  const moisOK=d.filter(x=>x.ca>=OBJ_CA).length;
  const objAnnuel=OBJ_CA*12;
  const pct=Math.min(Math.round(totalCA/Math.max(objAnnuel,1)*100),100);
  const moisRestants=12-filled.length;
  const isFixe=SAL.salType==='fixe';

  const prenom=SAL.prenom||'Toi';
  document.getElementById('home-greeting').textContent='Bonjour, '+prenom+' 👋';
  document.getElementById('home-poste').textContent=SAL.poste||'';
  document.getElementById('home-year-label').textContent=currentYear;
  const objDisp=document.getElementById('obj-ca-display');
  if(objDisp)objDisp.textContent=fmt(OBJ_CA).replace(' €','')+'€';
  // Adapter le label du tableau
  const thBase=document.getElementById('th-base');
  if(thBase)thBase.textContent=isFixe?'Brut':'CA HT';

  renderYearButtons();

  // HERO
  let hCol,hEmoji,hMsg,heroSub;
  if(isFixe){
    // En mode fixe : on n'a pas vraiment "d'objectif CA", on adapte
    const totalBrut=d.reduce((s,x)=>s+(x.brut||0),0);
    const objBrut=OBJ_CA*12;
    const pctB=Math.min(Math.round(totalBrut/Math.max(objBrut,1)*100),100);
    if(pctB>=90){hCol='var(--green)';hEmoji='🔥';hMsg='Exceptionnel';}
    else if(pctB>=70){hCol='var(--accent)';hEmoji='💪';hMsg='Très bien';}
    else if(pctB>=50){hCol='var(--orange)';hEmoji='⚡';hMsg='En route';}
    else{hCol='var(--red)';hEmoji='🎯';hMsg='À fond';}
    heroSub=`${fmt(totalBrut)} de brut sur ${fmt(objBrut)} visés`;
    document.getElementById('hero-bloc').innerHTML=`
      <div class="hero-label">${hEmoji} ${hMsg} — Bilan ${currentYear}</div>
      <div class="hero-title" style="color:${hCol}">${pctB}% atteint</div>
      <div class="hero-sub">${heroSub}</div>
      <div class="hero-bar-wrap"><div class="hero-bar" style="width:${pctB}%"></div></div>
      <div class="hero-bar-labels"><span>0</span><span style="color:${hCol};font-weight:700">${fmt(totalBrut)}</span><span>${fmt(objBrut)}</span></div>
      <div class="hero-grid">
        <div class="hero-stat"><div class="hero-stat-val" style="color:var(--green)">${filled.length}</div><div class="hero-stat-lbl">mois saisis</div></div>
        <div class="hero-stat"><div class="hero-stat-val" style="color:var(--accent)">${fmt(avgNet)}</div><div class="hero-stat-lbl">net moyen</div></div>
        <div class="hero-stat"><div class="hero-stat-val" style="color:var(--accent2)">${moisRestants}</div><div class="hero-stat-lbl">mois restants</div></div>
      </div>`;
  } else {
    if(pct>=90){hCol='var(--green)';hEmoji='🔥';hMsg='Exceptionnel';}
    else if(pct>=70){hCol='var(--accent)';hEmoji='💪';hMsg='Très bien';}
    else if(pct>=50){hCol='var(--orange)';hEmoji='⚡';hMsg='En route';}
    else{hCol='var(--red)';hEmoji='🎯';hMsg='À fond';}
    document.getElementById('hero-bloc').innerHTML=`
      <div class="hero-label">${hEmoji} ${hMsg} — Objectif ${currentYear}</div>
      <div class="hero-title" style="color:${hCol}">${pct}% atteint</div>
      <div class="hero-sub">${fmt(totalCA)} réalisés sur ${fmt(objAnnuel)} visés</div>
      <div class="hero-bar-wrap"><div class="hero-bar" style="width:${pct}%"></div></div>
      <div class="hero-bar-labels"><span>0</span><span style="color:${hCol};font-weight:700">${fmt(totalCA)}</span><span>${fmt(objAnnuel)}</span></div>
      <div class="hero-grid">
        <div class="hero-stat"><div class="hero-stat-val" style="color:var(--green)">${moisOK}</div><div class="hero-stat-lbl">mois ≥ obj.</div></div>
        <div class="hero-stat"><div class="hero-stat-val" style="color:var(--accent)">${fmt(avgNet)}</div><div class="hero-stat-lbl">net moyen</div></div>
        <div class="hero-stat"><div class="hero-stat-val" style="color:var(--accent2)">${moisRestants}</div><div class="hero-stat-lbl">mois restants</div></div>
      </div>`;
  }

  // MOTIV
  const reste=avgNet-charges;
  let mText,mColor,mBorder;
  if(avgNet===0){mText=`👋 Saisis tes premiers mois pour voir tes statistiques s'afficher.`;mColor='rgba(59,130,246,.08)';mBorder='var(--accent2)';}
  else if(reste>=800){mText=`💰 Avec ${fmt(avgNet)} de moyenne, il te reste ${fmt(reste)} après charges. Continue comme ça !`;mColor='rgba(34,197,94,.1)';mBorder='var(--green)';}
  else if(reste>=300){mText=`⚡ ${fmt(reste)} de marge après charges. Chaque bonne période, c'est de la liberté en plus.`;mColor='rgba(245,200,66,.08)';mBorder='var(--accent)';}
  else if(reste>=0){mText=`⚠️ Il ne te reste que ${fmt(reste)} après charges. Un seul bon mois changerait la donne.`;mColor='rgba(249,115,22,.1)';mBorder='var(--orange)';}
  else{mText=`🚨 Charges (${fmt(charges)}) > net moyen (${fmt(avgNet)}). Vise au moins ${fmt(charges)} de net.`;mColor='rgba(239,68,68,.1)';mBorder='var(--red)';}
  const msg=document.getElementById('motiv-msg');
  msg.textContent=mText;msg.style.background=mColor;msg.style.borderColor=mBorder;msg.style.color='var(--text)';

  // OBJECTIFS
  const tp=SAL.defaultPAS;
  const objList=[];
  if(!isFixe){
    objList.push({label:'Objectif mensuel',ca:OBJ_CA,icon:'🎯',color:'var(--green)'});
    if(charges>0)objList.push({label:'Couvrir les charges',ca:caFromNet(charges,tp),icon:'🏠',color:'var(--accent2)'});
  } else {
    objList.push({label:'Brut visé',ca:OBJ_CA,icon:'🎯',color:'var(--green)'});
  }
  document.getElementById('obj-list').innerHTML=objList.map(o=>{
    const r=calcSal(o.ca,tp);
    const net=isFixe?(SAL.fixe*(1-SAL.chargesPct/100)*(1-tp/100)):r.net;
    const isOK=avgNet>=net;
    return`<div class="obj-card" style="${isOK?'border-color:'+o.color+';background:rgba(0,0,0,.2)':''}">
      <div class="obj-icon">${o.icon}</div>
      <div class="obj-info">
        <div class="obj-label" style="${isOK?'color:'+o.color:''}">${o.label}</div>
        <div class="obj-sub">Net ≈ ${fmt(net)} · ${isOK?'✅ Atteint en moyenne':'Cible : '+fmt(o.ca)}</div>
      </div>
      <div class="obj-val" style="color:${o.color}">${fmt(o.ca)}</div>
    </div>`;
  }).join('');

  // JAUGE
  const last=[...d].reverse().find(x=>x.netPaye>0);
  const netCur=last?last.netPaye:avgNet;
  const soldeMois=netCur-charges;
  const pctC=netCur>0?Math.min(Math.round(charges/Math.max(netCur,1)*100),100):0;
  const gCl=pctC>90?'danger':pctC>70?'warn':'safe';
  document.getElementById('gauge-bloc').innerHTML=`
    <div class="gauge-title">Solde après charges — dernier mois saisi</div>
    <div class="gauge-sub">Net ${fmt(netCur)} − Charges ${fmt(charges)}</div>
    <div class="gauge-track"><div class="gauge-fill ${gCl}" style="width:${pctC}%"></div></div>
    <div class="gauge-labels"><span>0</span><span>${fmt(charges)} (${pctC}%)</span><span>${fmt(netCur)}</span></div>
    <div class="gauge-amount" style="color:${soldeMois>=0?'var(--green)':'var(--red)'}">${soldeMois>=0?'+':''}${fmt(soldeMois)}</div>
    <div class="gauge-desc">${soldeMois>=0?'disponible après charges':'⚠️ déficit ce mois'}</div>`;

  // KPI
  document.getElementById('kpi-annuel').innerHTML=`
    <div class="kpi"><div class="kpi-lbl">${isFixe?'Brut total':'CA HT total'}</div><div class="kpi-val" style="color:var(--accent)">${fmt(isFixe?d.reduce((s,x)=>s+(x.brut||0),0):totalCA)}</div><div class="kpi-sub">${isFixe?'cumul brut':'/ '+fmt(objAnnuel)+' visé'}</div></div>
    <div class="kpi"><div class="kpi-lbl">Net encaissé</div><div class="kpi-val" style="color:var(--green)">${fmt(totalNet)}</div><div class="kpi-sub">Moy. ${fmt(avgNet)}/mois</div></div>
    <div class="kpi"><div class="kpi-lbl">PAS prélevé</div><div class="kpi-val" style="color:var(--red)">${fmt(totalPAS)}</div><div class="kpi-sub">Impôt à la source</div></div>
    <div class="kpi"><div class="kpi-lbl">${isFixe?'Mois saisis':'Mois objectif'}</div><div class="kpi-val" style="color:var(--orange)">${isFixe?filled.length:moisOK}/12</div><div class="kpi-sub">${isFixe?'sur l\'année':'CA ≥ '+fmt(OBJ_CA)}</div></div>`;

  // TABLEAU
  const tbody=document.getElementById('table-tbody');
  tbody.innerHTML=d.map((x,i)=>{
    if(!x.ca&&!x.netPaye&&!x.brut)return`<tr><td style="color:var(--muted)">${MS[i]}</td><td colspan="4" style="color:var(--muted)">—</td></tr>`;
    const baseVal=isFixe?x.brut:x.ca;
    const diff=baseVal-OBJ_CA;
    const solde=x.netPaye-charges;
    return`<tr>
      <td style="font-weight:600">${MS[i]}</td>
      <td>${fmt(baseVal)}</td>
      <td><span class="${diff>=0?'bg-g':'bg-r'}">${diff>=0?'+':''}${Math.round(diff/100)/10}k</span></td>
      <td style="color:var(--green)">${fmt(x.netPaye)}</td>
      <td style="color:${solde>=0?'var(--green)':'var(--red)'}">${solde>=0?'+':''}${fmt(solde)}</td>
    </tr>`;
  }).join('');
  const totalBaseTab=isFixe?d.reduce((s,x)=>s+(x.brut||0),0):totalCA;
  tbody.innerHTML+=`<tr class="total-row"><td>Total</td><td>${fmt(totalBaseTab)}</td><td>${isFixe?filled.length:moisOK}/12</td><td>${fmt(totalNet)}</td><td>${fmt(totalNet)}</td></tr>`;

  // GRAPHIQUES
  if(chartCA)chartCA.destroy();
  chartCA=new Chart(document.getElementById('chart-ca'),{type:'bar',data:{labels:MS,datasets:[
    {data:d.map(x=>(isFixe?x.brut:x.ca)||null),backgroundColor:d.map(x=>(isFixe?x.brut:x.ca)>=OBJ_CA?'rgba(34,197,94,.75)':'rgba(249,115,22,.65)'),borderRadius:4},
    {data:Array(12).fill(OBJ_CA),type:'line',borderColor:'rgba(245,200,66,.8)',borderWidth:1.5,borderDash:[3,3],pointRadius:0,fill:false}
  ]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{grid:{display:false},ticks:{color:'#6B7280',font:{size:10}}},y:{grid:{color:'rgba(255,255,255,.04)'},ticks:{color:'#6B7280',font:{size:10},callback:v=>(v/1000)+'k'}}}}});
  if(chartNet)chartNet.destroy();
  chartNet=new Chart(document.getElementById('chart-net'),{type:'bar',data:{labels:MS,datasets:[
    {data:d.map(x=>x.netPaye||null),backgroundColor:'rgba(59,130,246,.75)',borderRadius:4},
    {data:Array(12).fill(charges),type:'line',borderColor:'rgba(239,68,68,.6)',borderWidth:1.5,borderDash:[3,3],pointRadius:0,fill:false}
  ]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{grid:{display:false},ticks:{color:'#6B7280',font:{size:10}}},y:{grid:{color:'rgba(255,255,255,.04)'},ticks:{color:'#6B7280',font:{size:10},callback:v=>(v/1000)+'k'}}}}});
}

// ── OBJECTIF EDIT ──
function openObjEdit(){const p=document.getElementById('obj-edit-panel');p.style.display='flex';document.getElementById('edit-obj-ca').value=OBJ_CA;previewObjNet();document.getElementById('edit-obj-ca').focus();}
function closeObjEdit(){document.getElementById('obj-edit-panel').style.display='none';}
function previewObjNet(){const v=parseFloat(document.getElementById('edit-obj-ca').value)||0;document.getElementById('edit-obj-net-preview').textContent=v>0?fmt(calcSal(v).net):'—';}
function saveObjEdit(){const v=parseFloat(document.getElementById('edit-obj-ca').value)||0;if(v<=0)return;OBJ_CA=v;sv('mp_obj',OBJ_CA);closeObjEdit();renderHome();}

// ════════════════════════════════════════════════════════════
//  MOIS
// ════════════════════════════════════════════════════════════
function renderMonthList(){
  const d=getData(),pd=getPD(),charges=totalDeps();
  const sel=document.getElementById('year-selector');if(sel)sel.value=currentYear;
  document.getElementById('month-list').innerHTML=MONTHS.map((m,i)=>{
    const x=d[i],filled=x.netPaye>0,partial=(x.ca>0||x.brut>0)&&!x.netPaye;
    const solde=filled?x.netPaye-charges:null;
    return`<div style="background:var(--surface);border:1px solid ${activeMonth===i?'var(--accent)':'var(--border)'};border-radius:12px;padding:14px 16px;display:flex;align-items:center;gap:12px;cursor:pointer" onclick="selectMonth(${i})">
      <div style="width:9px;height:9px;border-radius:50%;background:${filled?'var(--green)':partial?'var(--orange)':'var(--border)'};flex-shrink:0"></div>
      <div style="flex:1;min-width:0">
        <div style="font-size:15px;font-weight:600">${m}</div>
        <div style="font-size:11px;color:var(--muted);font-family:'DM Mono',monospace;margin-top:1px">${pd[i]}${solde!==null?' · reste <span style=color:'+(solde>=0?'var(--green)':'var(--red)')+'>'+(solde>=0?'+':'')+fmt(solde)+'</span>':''}</div>
      </div>
      <div style="font-family:'DM Mono',monospace;font-size:14px;color:${filled?'var(--green)':'var(--muted)'};text-align:right">${filled?fmt(x.netPaye):'—'}</div>
      <span style="color:var(--muted);font-size:16px">›</span>
    </div>`;
  }).join('');
}

function selectMonth(i){
  const d=getData(),pd=getPD(),x=d[i];
  activeMonth=i;
  document.getElementById('mois-list-view').style.display='none';
  const v=document.getElementById('mois-form-view');
  v.style.display='flex';v.style.flexDirection='column';
  document.getElementById('form-month-title').textContent=MONTHS[i]+' '+currentYear;
  document.getElementById('form-month-date-m').textContent='Virement le '+pd[i];
  document.getElementById('f-obj-display').textContent=fmt(OBJ_CA);
  document.getElementById('f-ca').value=x.ca||'';
  document.getElementById('f-brut').value=x.brut||'';
  document.getElementById('f-net-imposable').value=x.netImposable||'';
  document.getElementById('f-net-avant-pas').value=x.netAvantPAS||'';
  document.getElementById('f-pas').value=x.pas||'';
  document.getElementById('f-net-paye').value=x.netPaye||'';
  document.getElementById('f-taux-pas').value=x.tauxPAS||SAL.defaultPAS;
  document.getElementById('f-prime').value=x.prime||'';
  document.getElementById('f-cp').value=x.cp||'';
  document.getElementById('f-tr').value=x.tr||'';
  document.getElementById('f-note').value=x.note||'';
  // Adapter le label
  const lblCA=document.getElementById('lbl-ca');
  if(lblCA)lblCA.textContent=SAL.salType==='fixe'?'CA / Activité (€) — optionnel':'CA HT (€)';
  // Cacher CA si fixe
  document.getElementById('grp-ca').style.display=SAL.salType==='fixe'?'none':'flex';
  recalcForm();
  document.getElementById('page-mois').scrollTop=0;
}

function showMonthList(){
  document.getElementById('mois-list-view').style.display='block';
  document.getElementById('mois-form-view').style.display='none';
  renderMonthList();
}

function recalcForm(){
  const ca=parseFloat(document.getElementById('f-ca').value)||0;
  const tp=parseFloat(document.getElementById('f-taux-pas').value)||SAL.defaultPAS;
  if(SAL.salType==='fixe'){
    const r=calcSal(0,tp);
    document.getElementById('fc-ca-comm').textContent='—';
    document.getElementById('fc-fixe').textContent=fmt(r.fixe);
    document.getElementById('fc-brut-th').textContent=fmt(r.brut);
    document.getElementById('fc-net-est').textContent=fmt(r.net);
    document.getElementById('form-paliers-detail').innerHTML='';
    document.getElementById('row-ca-comm').style.display='none';
    return;
  }
  document.getElementById('row-ca-comm').style.display='flex';
  if(ca>0){
    const r=calcSal(ca,tp);
    document.getElementById('fc-ca-comm').textContent=fmt(r.caComm);
    document.getElementById('fc-fixe').textContent=fmt(r.fixe);
    document.getElementById('fc-brut-th').textContent=fmt(r.brut);
    document.getElementById('fc-net-est').textContent=fmt(r.net);
    // Détail paliers
    document.getElementById('form-paliers-detail').innerHTML=(r.detail||[]).map(p=>
      `<div class="cp-row"><span style="color:var(--muted);padding-left:14px;font-size:12px">Comm. ${fmtN(p.taux,1)}% (dès ${fmt(p.debut||p.seuil)})</span><span class="cp-val">${fmt(p.montant||0)}</span></div>`
    ).join('');
  }else{
    ['fc-ca-comm','fc-fixe','fc-brut-th','fc-net-est'].forEach(id=>document.getElementById(id).textContent='—');
    document.getElementById('form-paliers-detail').innerHTML='';
  }
}

function saveMonth(){
  if(activeMonth===null)return;
  const d=getData();
  d[activeMonth]={
    ca:parseFloat(document.getElementById('f-ca').value)||0,
    brut:parseFloat(document.getElementById('f-brut').value)||0,
    netImposable:parseFloat(document.getElementById('f-net-imposable').value)||0,
    netAvantPAS:parseFloat(document.getElementById('f-net-avant-pas').value)||0,
    pas:parseFloat(document.getElementById('f-pas').value)||0,
    netPaye:parseFloat(document.getElementById('f-net-paye').value)||0,
    tauxPAS:parseFloat(document.getElementById('f-taux-pas').value)||SAL.defaultPAS,
    prime:parseFloat(document.getElementById('f-prime').value)||0,
    cp:parseFloat(document.getElementById('f-cp').value)||0,
    tr:parseFloat(document.getElementById('f-tr').value)||0,
    note:document.getElementById('f-note').value||'',
  };
  setData(d);
  const btn=document.getElementById('save-btn');
  btn.textContent='✓ Enregistré !';btn.style.background='var(--green)';
  setTimeout(()=>{btn.textContent='Enregistrer';btn.style.background='var(--accent)';showMonthList();goPage('home');},1000);
}

function clearMonth(){
  if(activeMonth===null)return;
  if(!confirm('Effacer la fiche '+MONTHS[activeMonth]+' '+currentYear+' ?'))return;
  const d=getData();
  d[activeMonth]=emptyMonth();
  setData(d);
  showMonthList();
  goPage('home');
}

// ════════════════════════════════════════════════════════════
//  COMPTE PERSO
// ════════════════════════════════════════════════════════════
function renderCompte(){
  // Dépenses fixes
  renderDep();
  // Solde initial
  document.getElementById('compte-init-inp').value=compte.soldeInit||0;
  document.getElementById('compte-init-display').textContent=fmt(compte.soldeInit||0);

  // Calculs solde et bilan du mois en cours
  const now=new Date();
  const curMonth=now.getMonth(),curYear=now.getFullYear();
  let totalRev=0,totalDep=0,totalAll=compte.soldeInit||0;
  (compte.ops||[]).forEach(o=>{
    const d=new Date(o.date);
    if(o.type==='rev'){totalAll+=o.amount;}
    else{totalAll-=o.amount;}
    if(d.getMonth()===curMonth&&d.getFullYear()===curYear){
      if(o.type==='rev')totalRev+=o.amount;
      else totalDep+=o.amount;
    }
  });
  // Charges fixes mensuelles comptent comme dépense du mois
  const fixedMonthly=totalDeps();
  const bilan=totalRev-totalDep-fixedMonthly;

  document.getElementById('compte-solde').textContent=fmt(totalAll);
  document.getElementById('compte-solde').style.color=totalAll>=0?'var(--green)':'var(--red)';
  document.getElementById('compte-rev').textContent='+'+fmt(totalRev);
  document.getElementById('compte-dep').textContent='−'+fmt(totalDep+fixedMonthly);
  document.getElementById('compte-bal').textContent=(bilan>=0?'+':'')+fmt(bilan);
  document.getElementById('compte-bal').style.color=bilan>=0?'var(--green)':'var(--red)';

  // Date par défaut
  const dateInp=document.getElementById('op-date');
  if(dateInp&&!dateInp.value){
    dateInp.value=now.toISOString().slice(0,10);
  }

  renderOpsList();
}

function saveSoldeInit(){
  const v=parseFloat(document.getElementById('compte-init-inp').value)||0;
  compte.soldeInit=v;
  sv('mp_compte',compte);
  renderCompte();
}

function setOpType(t){
  opType=t;
  document.getElementById('op-mode-dep').classList.toggle('active',t==='dep');
  document.getElementById('op-mode-rev').classList.toggle('active',t==='rev');
}

function setOpCat(cat){
  document.getElementById('op-name').value=cat;
}

function addOp(){
  const name=document.getElementById('op-name').value.trim();
  const amount=parseFloat(document.getElementById('op-amount').value)||0;
  const date=document.getElementById('op-date').value||new Date().toISOString().slice(0,10);
  if(!name||amount<=0){alert('Saisis un nom et un montant.');return;}
  if(!compte.ops)compte.ops=[];
  compte.ops.push({id:opNextId++,name,amount,date,type:opType,cat:''});
  sv('mp_compte',compte);sv('mp_opid',opNextId);
  document.getElementById('op-name').value='';
  document.getElementById('op-amount').value='';
  renderCompte();
}

function deleteOp(id){
  if(!confirm('Supprimer cette opération ?'))return;
  compte.ops=(compte.ops||[]).filter(o=>o.id!==id);
  sv('mp_compte',compte);
  renderCompte();
}

function setOpFilter(f){
  opFilter=f;
  ['all','rev','dep'].forEach(x=>document.getElementById('filter-'+x).classList.toggle('active',x===f));
  renderOpsList();
}

function renderOpsList(){
  const list=document.getElementById('ops-list');
  if(!list)return;
  let ops=[...(compte.ops||[])];
  if(opFilter!=='all')ops=ops.filter(o=>o.type===opFilter);
  ops.sort((a,b)=>new Date(b.date)-new Date(a.date));
  if(ops.length===0){
    list.innerHTML=`<div style="text-align:center;padding:24px 0;color:var(--muted);font-size:12px">Aucune opération</div>`;
    return;
  }
  list.innerHTML=ops.slice(0,50).map(o=>`
    <div class="op-item">
      <div style="font-size:18px">${o.type==='rev'?'💰':'💸'}</div>
      <div class="op-info">
        <div class="op-name">${o.name}</div>
        <div class="op-date">${fmtDate(o.date)}</div>
      </div>
      <div class="op-amount ${o.type}">${o.type==='rev'?'+':'−'}${fmtC(o.amount)}</div>
      <button class="op-del" onclick="deleteOp(${o.id})">✕</button>
    </div>
  `).join('');
}

// ── DÉPENSES FIXES ──
function renderDep(){
  const t=totalDeps();
  const el=document.getElementById('dep-total-fixed');
  if(el)el.textContent=fmtD(t);
  const list=document.getElementById('dep-expense-list');
  if(!list)return;
  if(!deps.length){list.innerHTML=`<div style="text-align:center;padding:18px 0;color:var(--muted);font-size:12px">Aucune charge fixe</div>`;return;}
  list.innerHTML='';
  deps.forEach(exp=>{
    const isEd=depEditId===exp.id;const div=document.createElement('div');div.dataset.id=exp.id;
    if(isEd){
      div.innerHTML=`<div style="background:var(--surface2);border:1px solid var(--accent);border-radius:10px;padding:10px;display:flex;gap:6px;align-items:center">
        <input type="text" value="${exp.name}" style="flex:1;background:var(--surface3);border:1px solid var(--border);border-radius:6px;padding:8px;color:var(--text);font-size:.85rem;outline:none" id="ed-name-${exp.id}" onkeydown="if(event.key==='Enter')saveDep(${exp.id})">
        <input type="number" value="${exp.amount}" style="width:80px;background:var(--surface3);border:1px solid var(--border);border-radius:6px;padding:8px;color:var(--text);font-family:'DM Mono',monospace;font-size:.85rem;text-align:right;outline:none" id="ed-amt-${exp.id}" onkeydown="if(event.key==='Enter')saveDep(${exp.id})">
        <button onclick="saveDep(${exp.id})" style="padding:8px 12px;background:var(--accent);color:#000;border:none;border-radius:6px;font-weight:700;cursor:pointer">✓</button>
        <button onclick="cancelDep()" style="padding:8px;background:var(--surface3);border:1px solid var(--border);border-radius:6px;color:var(--muted);cursor:pointer">✕</button>
      </div>`;
    }else{
      div.innerHTML=`<div class="dep-row" ondblclick="editDep(${exp.id})">
        <div class="dn">${exp.name}</div>
        <div class="da">−${fmtC(exp.amount)}</div>
        <button onclick="editDep(${exp.id})" style="background:transparent;border:1px solid var(--border);border-radius:6px;color:var(--muted);font-size:.75rem;padding:4px 8px;cursor:pointer">✎</button>
        <button onclick="deleteDep(${exp.id})" style="background:transparent;border:1px solid var(--border);border-radius:6px;color:var(--red);font-size:.75rem;padding:4px 8px;cursor:pointer">✕</button>
      </div>`;
    }
    list.appendChild(div);
  });
}

function addDep(){
  const name=document.getElementById('dep-new-name').value.trim();
  const amount=parseFloat(document.getElementById('dep-new-amount').value)||0;
  if(!name||amount<=0)return;
  deps.push({id:depNextId++,name,amount});
  sv('mp_deps',deps);sv('mp_depid',depNextId);
  document.getElementById('dep-new-name').value='';
  document.getElementById('dep-new-amount').value='';
  renderDep();renderCompte();
}
function editDep(id){depEditId=id;renderDep();}
function cancelDep(){depEditId=null;renderDep();}
function saveDep(id){
  const exp=deps.find(d=>d.id===id);if(!exp)return;
  const nm=document.getElementById('ed-name-'+id).value.trim();
  const am=parseFloat(document.getElementById('ed-amt-'+id).value)||0;
  if(nm)exp.name=nm;if(am>0)exp.amount=am;
  depEditId=null;sv('mp_deps',deps);renderDep();renderCompte();
}
function deleteDep(id){
  if(!confirm('Supprimer cette charge ?'))return;
  deps=deps.filter(d=>d.id!==id);sv('mp_deps',deps);renderDep();renderCompte();
}

// ════════════════════════════════════════════════════════════
//  SIMULATEUR
// ════════════════════════════════════════════════════════════
function runCalc(){
  const v=parseFloat(document.getElementById('calc-main').value)||0;
  const tp=parseFloat(document.getElementById('pas-rate').value)||SAL.defaultPAS;
  document.getElementById('d-pas-pct').textContent=fmtN(tp,1);
  const pbtn=document.getElementById('pas-btn-perso');
  if(pbtn)pbtn.textContent=fmtN(SAL.defaultPAS,1)+'%';
  const isFixe=SAL.salType==='fixe';

  // Adapter labels
  document.getElementById('lbl-main').textContent=isFixe?(calcMode==='ca'?'Brut (€)':'Net souhaité (€)'):(calcMode==='ca'?'CA HT (€)':'Net souhaité (€)');
  document.getElementById('lbl-out').textContent=calcMode==='ca'?'Net payé estimé (€)':(isFixe?'Brut nécessaire (€)':'CA nécessaire (€)');
  document.getElementById('curve-x-label').textContent=isFixe?'Brut':'CA';
  document.getElementById('calc-sub').textContent=isFixe?'Brut ↔ Salaire net':'CA ↔ Salaire net';

  // Cacher CA commissionnable et fixe en mode fixe
  document.getElementById('dr-ca-comm').style.display=isFixe?'none':'flex';
  document.getElementById('dr-fixe').style.display=isFixe?'flex':(SAL.salType==='commission'?'none':'flex');

  // Décomposition paliers
  document.getElementById('d-fixe-lbl').textContent=fmt(isFixe?SAL.fixe:(SAL.salType==='commission'?0:SAL.fixe));
  document.getElementById('d-charges-lbl').textContent='Charges (~'+fmtN(SAL.chargesPct,1)+'%)';

  let r;
  if(calcMode==='ca'){
    if(isFixe){
      // En mode fixe : input = brut, on calcule le net direct
      const brut=v;
      const TC=SAL.chargesPct/100;
      const netAvant=brut*(1-TC);
      const pas=netAvant*(tp/100);
      r={brut,fixe:brut,comm:0,detail:[],caComm:0,netAvant,pas,net:netAvant-pas};
    } else {
      r=calcSal(v,tp);
    }
    document.getElementById('calc-output').value=v>0?fmtN(r.net,0):'';
  }else{
    if(isFixe){
      const brut=v>0?brutFromNet(v,tp):0;
      const TC=SAL.chargesPct/100;
      const netAvant=brut*(1-TC);
      const pas=netAvant*(tp/100);
      r={brut,fixe:brut,comm:0,detail:[],caComm:0,netAvant,pas,net:netAvant-pas};
      document.getElementById('calc-output').value=v>0?fmtN(brut,0):'';
    } else {
      const cn=v>0?caFromNet(v,tp):0;
      r=calcSal(cn,tp);
      document.getElementById('calc-output').value=v>0?fmtN(cn,0):'';
    }
  }

  document.getElementById('d-ca-comm').textContent=isFixe?'—':fmt(r.caComm);
  // Détail paliers dynamiques
  const palDetail=document.getElementById('paliers-detail');
  if(isFixe||!r.detail||r.detail.length===0){
    palDetail.innerHTML='';
  } else {
    palDetail.innerHTML=r.detail.map(p=>
      `<div class="dr"><span class="dk i">Comm. ${fmtN(p.taux,1)}% (dès ${fmt(p.debut||p.seuil)})</span><span class="dv">${fmt(p.montant||0)}</span></div>`
    ).join('');
  }
  document.getElementById('d-brut').textContent=fmt(r.brut);
  document.getElementById('d-charges').textContent='−'+fmt(r.brut*(SAL.chargesPct/100));
  document.getElementById('d-net-avant').textContent=fmt(r.netAvant);
  document.getElementById('d-pas-amount').textContent='−'+fmt(r.pas);
  document.getElementById('d-net-final').textContent=fmt(r.net);

  // Seuils clés
  const charges=totalDeps();
  let s=[];
  if(isFixe){
    s=[
      {label:'Brut actuel',ca:SAL.fixe,desc:'Net ≈ '+fmt(SAL.fixe*(1-SAL.chargesPct/100)*(1-tp/100))},
      {label:'Pour 1 500€ net',ca:brutFromNet(1500,tp),desc:''},
      {label:'Pour 2 000€ net',ca:brutFromNet(2000,tp),desc:''},
      {label:'Pour 2 500€ net',ca:brutFromNet(2500,tp),desc:''},
      {label:'Pour 3 000€ net',ca:brutFromNet(3000,tp),desc:''},
      {label:'Couvrir charges',ca:charges>0?brutFromNet(charges,tp):0,desc:charges>0?'Net = '+fmt(charges):'—'},
    ];
  } else {
    s=[
      {label:'Objectif mensuel',ca:OBJ_CA,desc:'Net ≈ '+fmt(calcSal(OBJ_CA,tp).net)},
      ...(charges>0?[{label:'Couvrir charges',ca:caFromNet(charges,tp),desc:'Net = '+fmt(charges)}]:[]),
      ...(charges>0?[{label:'+500 € épargne',ca:caFromNet(charges+500,tp),desc:'Net = '+fmt(charges+500)}]:[]),
      {label:'2 000 € net',ca:caFromNet(2000,tp),desc:''},
      {label:'2 500 € net',ca:caFromNet(2500,tp),desc:''},
      {label:'3 000 € net',ca:caFromNet(3000,tp),desc:''},
    ];
  }
  document.getElementById('seuil-grid').innerHTML=s.map(x=>`<div class="si"><div class="sv-val">${fmt(x.ca)}</div><div class="sl" style="font-weight:600;margin-bottom:2px">${x.label}</div><div class="sl">${x.desc}</div></div>`).join('');

  // Courbe
  const caR=[],netR=[];
  let caStart,caEnd,step;
  if(isFixe){caStart=0;caEnd=Math.max(SAL.fixe*2,5000);step=Math.round((caEnd-caStart)/40);}
  else{
    caStart=Math.max(SAL.franchise||0,1000);
    caEnd=Math.max((SAL.paliers&&SAL.paliers.length?SAL.paliers[SAL.paliers.length-1].seuil:5000)*3,30000);
    step=Math.round((caEnd-caStart)/50);
  }
  if(step<100)step=100;
  for(let ca=caStart;ca<=caEnd;ca+=step){
    caR.push(ca);
    if(isFixe){
      const TC=SAL.chargesPct/100;
      netR.push(Math.round(ca*(1-TC)*(1-tp/100)));
    } else {
      netR.push(Math.round(calcSal(ca,tp).net));
    }
  }
  if(chartCourbe)chartCourbe.destroy();
  chartCourbe=new Chart(document.getElementById('chart-courbe'),{type:'line',data:{labels:caR.map(v=>(v/1000).toFixed(1)+'k'),datasets:[
    {data:netR,borderColor:'#22C55E',borderWidth:2,pointRadius:0,fill:true,backgroundColor:'rgba(34,197,94,.08)'},
    {data:Array(caR.length).fill(charges),borderColor:'rgba(239,68,68,.5)',borderWidth:1,borderDash:[3,3],pointRadius:0,fill:false}
  ]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{grid:{display:false},ticks:{color:'#6B7280',font:{size:10},maxTicksLimit:8}},y:{grid:{color:'rgba(255,255,255,.04)'},ticks:{color:'#6B7280',font:{size:10},callback:v=>(v/1000)+'k€'}}}}});
}

function setMode(m){
  calcMode=m;
  document.getElementById('mode-ca').classList.toggle('active',m==='ca');
  document.getElementById('mode-net').classList.toggle('active',m==='net');
  document.getElementById('calc-main').value='';
  document.getElementById('calc-output').value='';
  runCalc();
}
function setPas(v,btn){
  document.getElementById('pas-rate').value=v;
  document.querySelectorAll('.pas-btn').forEach(b=>b.classList.remove('active'));
  if(btn)btn.classList.add('active');runCalc();
}

// ════════════════════════════════════════════════════════════
//  PARAMÈTRES
// ════════════════════════════════════════════════════════════
function toggleSection(id){
  const el=document.getElementById(id);
  const isHidden=el.style.display==='none';
  el.style.display=isHidden?'flex':'none';
  el.style.flexDirection='column';
  el.style.gap='12px';
}

function renderParams(){
  document.getElementById('p-prenom').value=SAL.prenom||'';
  document.getElementById('p-poste').value=SAL.poste||'';
  document.getElementById('p-fixe').value=SAL.fixe;
  document.getElementById('p-charges').value=SAL.chargesPct;
  document.getElementById('p-pas').value=SAL.defaultPAS;
  document.getElementById('p-franchise').value=SAL.franchise||0;

  // Type actif
  document.querySelectorAll('.type-btn').forEach(b=>b.classList.toggle('active',b.dataset.type===SAL.salType));
  const typeDescs={
    fixe:'💼 Salaire fixe : montant brut identique chaque mois, sans CA. Idéal pour un salarié classique.',
    commission:'📊 Commission seule : pas de fixe, uniquement % du CA. Aucune partie fixe garantie.',
    fixe_comm:'🔀 Fixe + commissions : un fixe garanti + des commissions selon le CA. Cas le plus courant.',
    custom:'⚙️ Personnalisé : configure librement le fixe, la franchise et les paliers selon ton contrat.'
  };
  document.getElementById('type-desc').textContent=typeDescs[SAL.salType]||'';

  // Adapter visibilité
  const showFixe=SAL.salType!=='commission';
  const showFranchise=SAL.salType!=='fixe';
  const showPaliers=SAL.salType!=='fixe';
  document.getElementById('row-fixe').style.display=showFixe?'flex':'none';
  document.getElementById('row-franchise').style.display=showFranchise?'flex':'none';
  document.getElementById('paliers-section').style.display=showPaliers?'flex':'none';

  renderPaliers();
  updateFormulaPreview();
}

function setSalType(type){
  SAL.salType=type;
  // Si on passe à 'fixe', vider les paliers
  if(type==='fixe'){SAL.paliers=[];}
  // Si on passe à 'commission', enlever fixe
  if(type==='commission'){SAL.fixe=0;}
  // Si on passe à 'fixe_comm' et pas de paliers, en créer un
  if(type==='fixe_comm'&&(!SAL.paliers||SAL.paliers.length===0)){
    SAL.paliers=[{seuil:0,taux:5}];
  }
  sv('mp_sal',SAL);
  renderParams();
  runCalc();
}

function renderPaliers(){
  const list=document.getElementById('paliers-list');
  if(!list)return;
  if(!SAL.paliers||SAL.paliers.length===0){
    list.innerHTML='<div style="text-align:center;padding:14px;color:var(--muted);font-size:12px">Aucun palier — ajoute-en un pour activer les commissions</div>';
    return;
  }
  list.innerHTML=SAL.paliers.map((p,i)=>`
    <div class="tier-bloc">
      <div class="tier-header">
        <div class="tier-name">Palier ${i+1}</div>
        <button class="tier-del" onclick="removePalier(${i})">✕ Supprimer</button>
      </div>
      <div class="tier-row">
        <span class="tier-label">Démarre à</span>
        <input class="tier-inp" type="number" value="${p.seuil}" inputmode="decimal" step="100" oninput="updatePalier(${i},'seuil',this.value)">
        <span class="tier-unit">€</span>
      </div>
      <div class="tier-row">
        <span class="tier-label">Taux de commission</span>
        <input class="tier-inp" type="number" value="${p.taux}" inputmode="decimal" step="0.1" oninput="updatePalier(${i},'taux',this.value)">
        <span class="tier-unit">%</span>
      </div>
    </div>
  `).join('');
}

function addPalier(){
  if(!SAL.paliers)SAL.paliers=[];
  if(SAL.paliers.length>=5){alert('Maximum 5 paliers.');return;}
  // Suggérer un seuil au-dessus du dernier
  const last=SAL.paliers.length?SAL.paliers[SAL.paliers.length-1]:null;
  const newSeuil=last?last.seuil+5000:0;
  const newTaux=last?Math.min(last.taux+2,30):10;
  SAL.paliers.push({seuil:newSeuil,taux:newTaux});
  sv('mp_sal',SAL);
  renderPaliers();updateFormulaPreview();runCalc();
}
function removePalier(i){
  if(!confirm('Supprimer ce palier ?'))return;
  SAL.paliers.splice(i,1);
  sv('mp_sal',SAL);
  renderPaliers();updateFormulaPreview();runCalc();
}
function updatePalier(i,field,val){
  if(!SAL.paliers[i])return;
  SAL.paliers[i][field]=parseFloat(val)||0;
  sv('mp_sal',SAL);
  updateFormulaPreview();runCalc();
}

function saveParams(){
  SAL.prenom=document.getElementById('p-prenom').value.trim();
  SAL.poste=document.getElementById('p-poste').value.trim();
  SAL.fixe=parseFloat(document.getElementById('p-fixe').value)||0;
  SAL.chargesPct=parseFloat(document.getElementById('p-charges').value)||0;
  SAL.defaultPAS=parseFloat(document.getElementById('p-pas').value)||0;
  SAL.franchise=parseFloat(document.getElementById('p-franchise').value)||0;
  sv('mp_sal',SAL);
  const pr=document.getElementById('pas-rate');if(pr)pr.value=SAL.defaultPAS;
  updateFormulaPreview();
  // Maj affichage profil accueil
  const greet=document.getElementById('home-greeting');
  if(greet&&SAL.prenom)greet.textContent='Bonjour, '+SAL.prenom+' 👋';
  const poste=document.getElementById('home-poste');
  if(poste)poste.textContent=SAL.poste||'';
}

function updateFormulaPreview(){
  const TC=SAL.chargesPct;
  const recap=document.getElementById('formula-recap');
  const prev=document.getElementById('params-formula-preview');
  let txt='Formule active :\n';
  if(SAL.salType==='fixe'){
    txt+=`1. Brut = ${fmt(SAL.fixe)} (fixe)\n2. Net imposable = Brut × (1 − ${fmtN(TC,1)}%)\n3. Net payé = Net imposable × (1 − ${fmtN(SAL.defaultPAS,1)}% PAS)`;
  } else {
    if(SAL.franchise>0)txt+=`1. CA exonéré jusqu'à ${fmt(SAL.franchise)}\n`;
    const ps=[...(SAL.paliers||[])].sort((a,b)=>a.seuil-b.seuil);
    ps.forEach((p,i)=>{
      const next=ps[i+1];
      const fin=next?` à ${fmt(next.seuil)}`:' et au-delà';
      txt+=`${i+(SAL.franchise>0?2:1)}. Palier ${i+1} : ${fmtN(p.taux,1)}% de ${fmt(p.seuil)}${fin}\n`;
    });
    const offset=SAL.franchise>0?ps.length+2:ps.length+1;
    if(SAL.salType!=='commission')txt+=`${offset}. Brut = ${fmt(SAL.fixe)} fixe + commissions\n`;
    else txt+=`${offset}. Brut = commissions\n`;
    txt+=`${offset+1}. Net avant PAS = Brut × (1 − ${fmtN(TC,1)}%)\n${offset+2}. Net payé = Net avant PAS × (1 − PAS%)`;
  }
  if(recap)recap.textContent=txt;

  if(prev){
    if(SAL.salType==='fixe'){
      prev.textContent=`Brut ${fmt(SAL.fixe)} → Net ≈ ${fmt(SAL.fixe*(1-TC/100)*(1-SAL.defaultPAS/100))}`;
    } else {
      const examples=[];
      const fr=SAL.franchise||0;
      examples.push(Math.round(fr*0.9));
      examples.push(Math.round(fr+2000));
      const ps=[...(SAL.paliers||[])].sort((a,b)=>a.seuil-b.seuil);
      if(ps.length>1)examples.push(ps[1].seuil+1000);
      examples.push((ps[ps.length-1]?.seuil||10000)+5000);
      prev.textContent=examples.filter(c=>c>0).map(ca=>`CA ${fmt(ca)} → Net ≈ ${fmt(calcSal(ca,SAL.defaultPAS).net)}`).join('\n');
    }
  }
}

// ════════════════════════════════════════════════════════════
//  SAUVEGARDE / IMPORT
// ════════════════════════════════════════════════════════════
function exportData(){
  const data={
    SAL,years,deps,depNextId,compte,opNextId,OBJ_CA,
    exportedAt:new Date().toISOString(),
    version:'2.0'
  };
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;
  a.download='ma-paie-backup-'+new Date().toISOString().slice(0,10)+'.json';
  document.body.appendChild(a);a.click();
  setTimeout(()=>{document.body.removeChild(a);URL.revokeObjectURL(url);},100);
}

function importData(event){
  const file=event.target.files[0];
  if(!file)return;
  if(!confirm('Importer ce fichier remplacera toutes tes données actuelles. Continuer ?'))return;
  const reader=new FileReader();
  reader.onload=e=>{
    try{
      const data=JSON.parse(e.target.result);
      if(data.SAL)SAL={...SAL_DEFAULT,...data.SAL};
      if(data.years)years=data.years;
      if(data.deps)deps=data.deps;
      if(data.depNextId)depNextId=data.depNextId;
      if(data.compte)compte=data.compte;
      if(data.opNextId)opNextId=data.opNextId;
      if(data.OBJ_CA)OBJ_CA=data.OBJ_CA;
      sv('mp_sal',SAL);sv('mp_years',years);sv('mp_deps',deps);
      sv('mp_depid',depNextId);sv('mp_compte',compte);sv('mp_opid',opNextId);sv('mp_obj',OBJ_CA);
      alert('Import réussi !');
      location.reload();
    }catch(err){
      alert('Fichier invalide : '+err.message);
    }
  };
  reader.readAsText(file);
}

function resetData(){
  if(!confirm('Effacer toutes les données de paie, opérations et charges ?'))return;
  years={[currentY]:emptyYear()};
  deps=[];depNextId=1;
  compte={soldeInit:0,ops:[]};opNextId=1;
  sv('mp_years',years);sv('mp_deps',deps);sv('mp_depid',depNextId);
  sv('mp_compte',compte);sv('mp_opid',opNextId);
  renderHome();renderMonthList();renderCompte();
  alert('Données effacées.');
}
function resetAll(){
  if(!confirm('Tout réinitialiser ? Profil et paramètres inclus.'))return;
  if(!confirm('Vraiment ? Cette action est définitive.'))return;
  localStorage.clear();
  location.reload();
}

// ════════════════════════════════════════════════════════════
//  INIT
// ════════════════════════════════════════════════════════════
checkOnboarding();
renderYearButtons();
renderHome();
renderMonthList();
runCalc();
// Date par défaut pour ajout opération
const dateInp=document.getElementById('op-date');
if(dateInp)dateInp.value=new Date().toISOString().slice(0,10);
