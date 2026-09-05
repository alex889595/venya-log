/* Номер збірки беремо з ?v= у власному тегу script: так одразу видно, чи
   браузер віддав свіжі файли, чи тримає стару копію з пам'яті. */
const BUILD=((document.currentScript&&document.currentScript.src||'').match(/v=(\d+)/)||[])[1]||'?';
console.log('venya build v'+BUILD);

const BANDS=[
  {max:3,  color:'#B3252F', name:'дуже низько'},
  {max:5,  color:'#E0504F', name:'низько'},
  {max:15, color:'#A3C585', name:'ціль'},
  {max:20, color:'#E8C05A', name:'високо'},
  {max:1e9,color:'#E0873C', name:'дуже високо'}
];
const C_INS='#5AA9E6', C_FOOD='#A78BE0', HI_COLOR='#E0873C';
const GAP_H=6;
const CHEV=`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`;          /* довша пауза — лінія рветься */
const SHIFT_H=1;        /* зсув уколу більший за це — позначаємо */

const bandOf=g=>BANDS.find(b=>g<b.max);
const colorFor=e=>e.hi?HI_COLOR:(e.glucose==null?null:bandOf(e.glucose).color);
/* глюкоза і дози завжди з десятковою: 8 показуємо як 8,0, щоб колонка не стрибала */
const fmt=n=>{
  const r=Math.round(n*100)/100;
  return (Number.isInteger(r)?r.toFixed(1):String(r)).replace('.',',');
};
const esc=s=>(s||'').replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
/* Тільки перша літера: «ОД», «Hi» та інші скорочення мають лишитись як є. */
const lower=s=>s?s[0].toLowerCase()+s.slice(1):s;
/* Стан. Порожній до першого завантаження; наповнює adopt() з api.js. */
let TODAY = new Date().toISOString().slice(0, 10);
let view='glucose', editing=null;

let log=[], regimens=[], meds=[], urine=[], stool=[], days=[];
/* Адресу таблиці віддає API, а не config.js: у публічному репозиторії їй не
   місце, бо таблиця відкрита на редагування за посиланням. */
let sheetUrl='', notionUrl='';
/* Вага з відповіді скрипта. Нуль означає «скрипт її ще не віддає» — тоді
   беремо копію з пристрою. */
let serverWeight=0;
/* Початок завантаженого вікна: за ним видно, чи вистачає даних на обраний
   період, чи треба спершу довантажити. */
let loadedFrom='';

const regOf=rid=>regimens.find(r=>r.id===rid)||{name:'\u2014'};
const activeRegimens=(date=TODAY)=>regimens.filter(r=>r.from<=date&&(!r.to||r.to>=date));

const medsOn=date=>meds.filter(m=>m.date===date);
const medName=m=>regOf(m.rid).name;

/* той самий список, що у випадному списку аркуша */
const STOOL=['не какав','сухий','нормальний',"м'який",'рідкий'];
const stoolOn=date=>stool.find(x=>x.date===date)||null;

const MONTHS=['січня','лютого','березня','квітня','травня','червня','липня','серпня','вересня','жовтня','листопада','грудня'];
const stamp=e=>e.date+'T'+(e.time||'00:00');
/* Рядок без часу — законний: буває, що записано лише корм чи нотатку. Але на
   часовій осі йому немає місця, тому з графіків його прибираємо. */
const timed=e=>!!e.time;
const hrs=(a,b)=>(new Date(stamp(b))-new Date(stamp(a)))/36e5;
function dayName(iso){
  const d=new Date(iso+'T00:00:00');
  const diff=Math.round((new Date(TODAY+'T00:00:00')-d)/864e5);
  return diff===0?'Сьогодні':diff===1?'Учора':d.getDate()+' '+MONTHS[d.getMonth()];
}

/* уколи чергуються ранок/вечір; пропущений (доза 0) теж рахується */
const AM_GAP=18;  /* стільки годин від попереднього ранкового — і це вже новий ранок */
function shotsAsc(){
  const asc=[...log].sort((a,b)=>stamp(a).localeCompare(stamp(b)));
  const s=asc.filter(e=>e.insulin!=null);
  // Не за парністю: якщо один укол колись не запишеться, парність перекине всі наступні доби.
  // Розрив від останнього ранкового витримує і зсуви, і пропуски.
  let lastAm=null;
  s.forEach(x=>{
    if(!lastAm||hrs(lastAm,x)>=AM_GAP){x._slot='am';lastAm=x}
    else x._slot='pm';
  });
  return {asc,shots:s};
}
function buildDays(){
  const {asc,shots}=shotsAsc();
  const ams=shots.filter(s=>s._slot==='am');
  const groups=[];
  asc.forEach(e=>{
    if(e.insulin!=null&&e._slot==='am') groups.push({anchor:e,date:e.date,entries:[]});
    if(!groups.length) groups.push({anchor:null,date:e.date,entries:[]});
    groups[groups.length-1].entries.push(e);
  });
  groups.forEach((g,i)=>{
    const pm=g.entries.find(x=>x.insulin!=null&&x._slot==='pm');
    // сам вечірній укол уже належить нічній половині
    g.entries.forEach(e=>e._night = !!pm && stamp(e)>=stamp(pm));
    const idx=ams.indexOf(g.anchor);
    const prevAm=ams[idx-1], nextAm=ams[idx+1];
    g.shift = g.anchor&&prevAm ? hrs(prevAm,g.anchor)-24 : 0;
    // закрита доба тягнеться до наступного якоря, поточна — до останнього запису
    const t0=g.anchor||g.entries[0];
    // передукольний замір наступної доби замикає криву на правому краї
    g.next = nextAm || null;
    g.span = nextAm ? hrs(t0,nextAm) : Math.max(hrs(t0,g.entries[g.entries.length-1])+0.5, 6);
    g.entries.reverse();
  });
  return groups.reverse();
}
/* попередній замір з числом — через порожні записи і через межі груп */
function prevMeasured(e){
  const asc=[...log].filter(x=>x.glucose!=null).sort((a,b)=>stamp(a).localeCompare(stamp(b)));
  const i=asc.findIndex(x=>x.id===e.id);
  return i>0?asc[i-1]:null;
}

/* Вісь від якоря доби, не від годинника: кожна крива починається зліва.
   Вісь малюється на всю довжину циклу, тому короткий ряд замірів читається
   як «далі даних не було», а не як обрізаний графік. */
function sparkline(g,o={}){
  const W=o.W||600, H=o.H||84, R=o.r||4.6, SW=o.sw||2.6;
  const padB=Math.round(H*.23), padT=Math.round(H*.13), mY=28;
  const asc=[...g.entries].sort((a,b)=>stamp(a).localeCompare(stamp(b)));
  const t0=g.anchor||asc[0];
  /* вісь тягнеться до наступного ранкового уколу, а замір, знятий перед ним,
     стає кінцевою точкою кривої — тому вона доходить до правого краю,
     і при цьому доби лишаються порівнюваними між собою */
  const span=Math.max(6,g.span||6);
  const PX=R+2;
  const Xh=h=>PX+Math.min(Math.max(h,0),span)/span*(W-PX*2);
  const X=e=>Xh(hrs(t0,e));
  const Y=v=>H-padB-(Math.min(v,mY)/mY)*(H-padB-padT);
  const chain=g.next&&(g.next.glucose!=null||g.next.hi)?asc.concat([g.next]):asc;
  const pts=chain.filter(e=>timed(e)&&(e.glucose!=null||e.hi))
    .map(e=>({e,y:e.hi?mY:e.glucose,c:colorFor(e),edge:e===g.next}));

  let s=`<line x1="${PX}" y1="${H-padB}" x2="${W-PX}" y2="${H-padB}"
    stroke="var(--hairline)" stroke-width="1"/>`;
  for(let h=6;h<span;h+=6)
    s+=`<line x1="${Xh(h)}" y1="${H-padB-3}" x2="${Xh(h)}" y2="${H-padB+3}"
      stroke="var(--hairline)" stroke-width="1"/>`;

  for(let i=1;i<pts.length;i++){
    const gap=hrs(pts[i-1].e,pts[i].e)>GAP_H;
    s+=`<line x1="${X(pts[i-1].e)}" y1="${Y(pts[i-1].y)}" x2="${X(pts[i].e)}" y2="${Y(pts[i].y)}"
      stroke="${pts[i].c}" stroke-width="${SW}" stroke-linecap="round"
      ${gap?`stroke-dasharray="${SW} ${SW*2}" opacity=".4"`:''}/>`;
  }
  asc.filter(e=>e.insulin!=null).forEach(e=>{
    s+=`<line x1="${X(e)}" y1="${H-padB+5}" x2="${X(e)}" y2="${H-padB-11}"
      stroke="${C_INS}" stroke-width="${SW+.8}" stroke-linecap="round"
      ${e.insulin===0?'stroke-dasharray="2 3" opacity=".5"':''}/>`;});
  if(o.food!==false) asc.filter(e=>e.food).forEach(e=>{
    const x=X(e),y=H-R-1;
    s+=`<path d="M${x} ${y-R} L${x+R} ${y} L${x} ${y+R} L${x-R} ${y} Z" fill="${C_FOOD}"/>`;});
  pts.forEach(p=>{
    s+= p.edge
      ? `<circle cx="${X(p.e)}" cy="${Y(p.y)}" r="${R-.6}" fill="var(--card-day)"
          stroke="${p.c}" stroke-width="${SW*.8}"/>`
      : `<circle cx="${X(p.e)}" cy="${Y(p.y)}" r="${R}" fill="${p.c}"/>`;
    if(p.e.hi)s+=`<circle cx="${X(p.e)}" cy="${Y(p.y)}" r="${R*1.9}" fill="none"
      stroke="${p.c}" stroke-width="${SW*.6}" opacity=".7" stroke-dasharray="3 3"/>`;
  });
  return `<svg class="${o.cls||'spark'}" viewBox="0 0 ${W} ${H}">${s}</svg>`;
}

/* Порядок один на всі списки: журнал, «По добах», картки і «Сеча і стул».
   Дві таблиці про ті самі доби не мають читатись у різні боки. Типово
   хронологічний, як у Таблицях і в месенджерах. */
let chronoOrder=true;
const chronoNow=()=>chronoOrder;
/* Просимо поставити сторінку на найсвіжіші записи при наступному малюванні.
   Живе прапорцем, а не викликом, бо малювання буває відкладеним. */
let needScroll=true;

/**
 * Режим перегляду: з екрана йде весь хром — бар, плашка, липкість шапки — і
 * рядки перестають відкривати форму. Це не лише про скріншот для лікарки:
 * так само можна дати телефон у руки і показати журнал, не боячись, що
 * випадковий тап відкриє редагування.
 */
let shotMode=false;
/* Кінці виділеного діапазону — id рядків. Виділення живе лише в режимі
   перегляду і потрібне рівно для одного: показати, які рядки нові. */
let selA=null, selB=null;

/* Які доби розгорнуті. Тримаємо окремо від розмітки, бо renderGlucose
   перебудовує її повністю — інакше вибір губився б при кожному перемиканні
   порядку чи режиму. Відкритих може бути скільки завгодно. */
const openDays=new Set();
let openSeeded=false;

/* Скільки діб уже попросили і чи лишилось що просити. «Все» визначаємо не за
   датами, а за тим, що більший період не приніс жодного нового рядка: так не
   треба знати, коли саме почались записи. */
let daysWanted=CONFIG.defaultDays;
let allLoaded=false;
let loadingMore=false;

/**
 * Чи лишилось що вантажити.
 *
 * Скрипт віддає найранішу дату кожного аркуша (`first`), і тоді це просте
 * порівняння: вікно або дотягується до неї, або ні. Раніше застосунок
 * здогадувався сам — «найстаріший рядок стоїть рівно на краю вікна, отже, за
 * ним щось є», — і не міг відрізнити «є ще» від «дані просто там починаються».
 * Через це кнопка лишалась висіти після того, як вантажити вже не було чого.
 */
const EDGES=['journal','urine','day','med'];
let firstDates=null;
function markAllLoaded(payload){
  firstDates=payload.first||null;
  if(firstDates){
    /* Вікно вже дотягується до найранішої дати кожного аркуша — далі нічого. */
    allLoaded=EDGES.every(k=>!firstDates[k]||payload.from<=firstDates[k]);
    return;
  }
  /* Старий скрипт не каже, де починаються дані, тому доводиться здогадуватись
     по краю вікна. Здогадка коштує зайвого натискання, але не замикає: якщо
     найстаріший рядок новіший за початок запитаного, глибше нічого немає. */
  const dates=[];
  (payload.journal||[]).forEach(r=>{if(r.date)dates.push(r.date)});
  (payload.urine||[]).forEach(r=>{if(r.date)dates.push(r.date)});
  (payload.days||[]).forEach(r=>{if(r.date)dates.push(r.date)});
  /* Порожнє вікно не означає «даних більше немає» — воно означає лише, що в
     цьому проміжку нічого немає. Різниця вилазить після паузи в записах:
     висновок «усе завантажено» замкнув би застосунок на порожньому екрані. */
  if(!dates.length){allLoaded=false;return}
  dates.sort();
  allLoaded=!!(payload.from&&dates[0]>payload.from);
}

/* Одна кнопка на всі списки: журнал і «По добах» мають читатись однаково. */
function orderBtn(){
  const chrono=chronoNow();
  return `<button class="ordbtn" data-jo="${chrono?'0':'1'}">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 5v14"/><path d="${chrono?'M6 13l6 6 6-6':'M6 11l6-6 6 6'}"/></svg>
    ${chrono?'старіше зверху':'свіже зверху'}</button>`;
}

function orderBar(){
  const chrono=chronoNow();
  return `<div class="jbar">
    <button class="ordbtn" data-jo="${chrono?'0':'1'}">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 5v14"/><path d="${chrono?'M6 13l6 6 6-6':'M6 11l6-6 6 6'}"/></svg>
      ${chrono?'старіше зверху':'свіже зверху'}</button>
    <button class="ordbtn icon${shotMode?' on':''}" data-shot="1" aria-pressed="${shotMode}"
      aria-label="Режим перегляду" title="Режим перегляду: без кнопок і без редагування">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
        <path d="M1.5 12S5 5.5 12 5.5 22.5 12 22.5 12 19 18.5 12 18.5 1.5 12 1.5 12z"/>
        <circle cx="12" cy="12" r="3.2"/></svg></button>
  </div>`;
}
function bindOrder(){
  document.querySelectorAll('[data-jo]').forEach(b=>
    b.onclick=()=>{chronoOrder=b.dataset.jo==='1';
      needScroll=true;setView(view)});
  document.querySelectorAll('[data-shot]').forEach(b=>
    b.onclick=()=>{shotMode=!shotMode;if(!shotMode)selA=selB=null;
      applyShot();setView(view)});
}
/**
 * Фарбує рядки між двома кінцями. Йдемо по DOM, а не по даних: порядок на
 * екрані міняється кнопкою сортування, і виділення має слухатись саме його.
 */
function paintSelection(){
  const rows=[...document.querySelectorAll('.dr[data-edit]')];
  rows.forEach(r=>r.classList.remove('sel','sel-a','sel-b'));
  if(!selA)return;
  const i=rows.findIndex(r=>r.dataset.edit===selA);
  const j=selB?rows.findIndex(r=>r.dataset.edit===selB):i;
  if(i<0||j<0)return;
  const lo=Math.min(i,j), hi=Math.max(i,j);
  for(let k=lo;k<=hi;k++)rows[k].classList.add('sel');
  rows[lo].classList.add('sel-a');
  rows[hi].classList.add('sel-b');
}

/* Тап по рядку в режимі перегляду: перший — початок, другий — кінець,
   тап по вже позначеному краю знімає виділення. */
function pickRow(id){
  if(!selA){selA=id;selB=id}
  else if(id===selA||id===selB){selA=selB=null}
  else selB=id;
  paintSelection();
}

/**
 * Розділ, який читається за порядком сортування: журнал, «Сеча і стул» і
 * списки у «Зведенні». Графіки сюди не входять — у них вісь задає себе сама.
 */
const isList=()=>view==='glucose'||view==='urine'||
  (view==='cycles'&&(sumMode==='rows'||sumMode==='cards'));

/**
 * Позиція до заміни розмітки. Знімати її треба саме тут: `innerHTML` на мить
 * робить документ коротким, браузер підтягує прокрутку до нуля — і будь-яке
 * перемалювання (свіжі дані, довантаження, збережений запис) викидало на
 * найстаріші записи. Тримаємо і відступ від низу: у хронологічному порядку
 * старіші рядки додаються згори, і «та сама позиція» — це та сама відстань до
 * кінця, а не до початку.
 */
let keepY=0, keepBottom=0;
function beginRender(){
  keepY=window.scrollY;
  keepBottom=document.documentElement.scrollHeight-window.scrollY;
}

/**
 * Після малювання ставимо сторінку туди, де найсвіжіші записи: унизу при
 * хронологічному порядку, угорі при зворотному. Так буває при заході в розділ,
 * зміні подання і зміні сортування. Решта перемалювань лишає людину на місці.
 */
function afterRender(){
  const go=needScroll, y=keepY, fromEnd=keepBottom;
  needScroll=false;
  requestAnimationFrame(()=>{
    const H=document.documentElement.scrollHeight;
    if(go)window.scrollTo({top:isList()&&chronoNow()?H:0});
    else window.scrollTo({top:isList()&&chronoNow()?Math.max(0,H-fromEnd):y});
    if(window.rebaseHeader)window.rebaseHeader();
    /* Заголовки таблиць липнуть під смугою, а її висота залежить від того,
       що в ній стоїть. Тому міряємо, а не вписуємо число. */
    const st=document.querySelector('.stick');
    document.body.style.setProperty('--stick-h',(st?st.offsetHeight:0)+'px');
    updateJump();
  });
}

/* Найновіші — там, куди веде порядок: унизу при хронологічному, угорі при
   зворотному. Язичок показуємо, лише коли до них справді далеко. */
const jumpBtn=document.getElementById('jumpBtn');
function jumpTarget(){
  return chronoNow()?document.documentElement.scrollHeight:0;
}
function updateJump(){
  if(!jumpBtn)return;
  if(!isList()||shotMode){jumpBtn.hidden=true;return}
  const vh=window.innerHeight, y=window.scrollY;
  const far=chronoNow()
    ? (document.documentElement.scrollHeight-(y+vh))>vh*0.8
    : y>vh*0.8;
  jumpBtn.hidden=!far;
  jumpBtn.textContent=chronoNow()?'↓':'↑';
  jumpBtn.title='До найновіших записів';
  jumpBtn.setAttribute('aria-label','До найновіших записів');
}
if(jumpBtn)jumpBtn.onclick=()=>{
  window.scrollTo({top:jumpTarget(),behavior:'smooth'});
  setTimeout(()=>{if(window.rebaseHeader)window.rebaseHeader();updateJump()},450);
};

function denseRows(){
  const chrono=chronoNow();
  const asc=[...log].sort((a,b)=>chrono
    ? stamp(a).localeCompare(stamp(b))
    : stamp(b).localeCompare(stamp(a)));
  let prevDate=null, out='';
  asc.forEach(e=>{
    const c=colorFor(e);
    const newDay=e.date!==prevDate;
    const bits=[];
    if(e.insulin===0)bits.push('<b class="ins">укол пропущено</b>');
    else if(e.insulin!=null)bits.push(`<b class="ins">${fmt(e.insulin)} ОД</b>`);
    if(e.food)bits.push(esc(e.food));
    medsOn(e.date).filter(m=>(m.time||'')===e.time).forEach(m=>
      bits.push(esc(medName(m))));
    if(e.note)bits.push(`<span class="dn">${esc(e.note)}</span>`);
    out+=`<div class="dr${newDay?' d0':''}" data-edit="${e.id}">
      <span class="dd">${newDay?dateShort(e.date):''}</span>
      <span class="dt">${e.time}</span>
      <span class="dg"${c?` style="color:${c}"`:''}>${
        e.hi?'Hi':e.glucose!=null?fmt(e.glucose):'—'}</span>
      <span class="dx">${bits.join(', ')}</span></div>`;
    prevDate=e.date;
  });
  return `<div class="dtable">
    <div class="dr dh"><span class="dd">Дата</span><span class="dt">Час</span><span class="dg">Ммоль</span><span class="dx">Маніпуляції / нотатки</span></div>
    ${out}</div>`;
}

/* Старіше — там, куди гортаєш за старішим: угорі при хронологічному порядку
   і внизу при зворотному. */
/**
 * Чи є що вантажити саме для цього набору. Питання не спільне: сеча
 * починається 10.08, і коли вікно вже тягнеться з 02.08, старіших записів
 * лотка не існує — кнопка там зайва, хоча в журналі вона ще потрібна.
 */
const EDGE_OF={journal:['journal'],urine:['urine','day'],meds:['med']};

function hasMore(kind){
  if(!loadedFrom)return !allLoaded;
  if(firstDates){
    return (EDGE_OF[kind]||EDGE_OF.journal)
      .some(k=>firstDates[k]&&loadedFrom>firstDates[k]);
  }
  if(allLoaded)return false;
  const arr=kind==='urine'?urine:kind==='meds'?meds:log;
  if(!arr.length)return false;
  return arr.map(x=>x.date).sort()[0]<=loadedFrom;
}

function moreBar(kind){
  if(!hasMore(kind))return '';
  return `<div class="morebar"><button class="btn ghost" id="moreBtn"${
    loadingMore?' disabled':''}>${
    loadingMore?'Вантажу…':'Показати ще 30 діб'}</button></div>`;
}

/* Один запит приносить усі аркуші одразу, тому «показати ще» однаково
   стосується журналу, зведення, сечі й ліків — і кнопка потрібна в кожному з
   них. Перемальовуємо той вигляд, у якому людина стоїть. */
function bindMore(){
  const b=document.getElementById('moreBtn');
  if(b)b.onclick=async()=>{
    loadingMore=true;setView(view);
    const had=log.length+urine.length+meds.length;
    try{
      const data=await API.load(daysWanted+30);
      daysWanted+=30;
      adopt(data);
      markAllLoaded(data);
      /* Нові рядки лягають на дальній кінець списку — звідти, де ти стоїш, їх
         не видно. Без цього рядка здається, що кнопка не спрацювала. */
      const add=log.length+urine.length+meds.length-had;
      /* Порожній крок і кінець даних — різні речі. Поки скрипт не казав, де
         починаються записи, розрізнити їх було нічим, і після паузи в записах
         застосунок обіцяв, що старіших немає, хоча вони були. */
      say(add?`Завантажено ще ${add} ${plural(add,'запис','записи','записів')}`
             :hasMore('journal')?'У цьому проміжку записів немає, гортайте далі'
             :'Старіших записів більше немає','wait');
      setTimeout(()=>say(API.pending()?'Не відправлено записів: '+API.pending():''),4000);
    }catch(err){
      say('Не вдалося довантажити: '+esc(String(err.message||err)),'err');
    }
    loadingMore=false;
    setView(view);
  };
}

function renderGlucose(){
  beginRender();
  const more=moreBar('journal');
  document.getElementById('main').innerHTML=orderBar()+
    (chronoNow()?more:'')+denseRows()+(chronoNow()?'':more);
  document.getElementById('side').innerHTML='';
  bindOrder();bindMore();
  document.querySelectorAll('.dr[data-edit]').forEach(r=>
    r.onclick=()=>{ shotMode?pickRow(r.dataset.edit):openEntry(r.dataset.edit) });
  paintSelection();
  afterRender();
}

/**
 * Картки — це подання доби: спарклайн, чіпи, підсумки. Тому вони живуть у
 * «Зведенні», а не в журналі; журнал лишається однією таблицею, і в нього
 * більше не треба перемикача подань.
 */
function renderCards(){
  beginRender();
  const modeBar=sumBar();
  if(!log.length){
    document.getElementById('main').innerHTML=modeBar+
      '<div class="empty">Записів ще немає.</div>';
    document.getElementById('side').innerHTML='';
    bindSum();bindHint();afterRender();
    return;
  }
  const chrono=chronoNow();
  const groups=buildDays();
  if(chrono){groups.reverse();groups.forEach(g=>g.entries.reverse())}
  let html=modeBar+`<div class="legend">
    <span><svg width="10" height="10"><circle cx="5" cy="5" r="4" fill="${BANDS[2].color}"/></svg> глюкоза</span>
    <span><svg width="10" height="10"><rect x="3.5" y="0" width="3" height="10" rx="1.5" fill="${C_INS}"/></svg> інсулін</span>
    <span><svg width="10" height="10"><path d="M5 1 L9 5 L5 9 L1 5 Z" fill="${C_FOOD}"/></svg> корм</span>
    <span><svg width="18" height="10"><line x1="1" y1="5" x2="17" y2="5" stroke="${BANDS[2].color}"
      stroke-width="2" stroke-dasharray="2.5 3" opacity=".55"/></svg> понад ${GAP_H} год без замірів</span>
    <span><svg width="14" height="14"><circle cx="7" cy="7" r="2.6" fill="${BANDS[BANDS.length-1].color}"/>
      <circle cx="7" cy="7" r="5.6" fill="none" stroke="${BANDS[BANDS.length-1].color}"
      stroke-width="1.2" stroke-dasharray="2.5 2.5" opacity=".8"/></svg> Hi, поза шкалою</span>
  </div>`;

  /* старіше — там, куди гортаєш за старішим */
  if(chrono)html+=moreBar('journal');

  if(!openSeeded&&groups.length){
    openDays.add(groups[chrono?groups.length-1:0].date);
    openSeeded=true;
  }

  groups.forEach((g,gi)=>{
    const nums=g.entries.filter(e=>e.glucose!=null).map(e=>e.glucose);
    const doses=g.entries.filter(e=>e.insulin!=null).sort((a,b)=>stamp(a).localeCompare(stamp(b)))
      .map(e=>e.insulin===0?'пропуск':fmt(e.insulin));
    const open=openDays.has(g.date);
    const uml=urine.filter(u=>u.date===g.date).reduce((s,u)=>s+u.ml,0);

    let rows='';
    g.entries.forEach((e,i)=>{
      const c=colorFor(e), prev=g.entries[i+1], next=g.entries[i-1];
      const cIn=next?colorFor(next):null, cOut=prev?colorFor(prev):null;
      /* Віддаємо самі кольори, а градієнт будує CSS одним шматком: два
         окремі відрізки різної довжини мінялись з різною швидкістю і на
         вузлі виходив злам. */
      const st=[c?`--dot:${c}`:'',
        c&&cIn?`--c-in:${cIn}`:'',
        c&&cOut?`--c-out:${cOut}`:''].filter(Boolean).join(';');
      let delta='';
      const ref=prevMeasured(e);
      if(ref&&e.glucose!=null){
        const dv=e.glucose-ref.glucose, dt=hrs(ref,e);
        if(dt>0&&Math.abs(dv)>=0.5)
          delta=`<span class="delta">${dv<0?'↓':'↑'} ${fmt(Math.abs(dv))} за ${fmt(dt)} год</span>`;
      }
      const chips=[];
      if(e.insulin===0) chips.push('<span class="chip skip">ін\'єкцію пропущено</span>');
      else if(e.insulin) chips.push(`<span class="chip dose">${fmt(e.insulin)} ОД Лантус</span>`);
      if(e.food) chips.push(`<span class="chip food">${esc(e.food)}</span>`);
      const long=(e.note||'').length>95;
      rows+=`<article class="entry${e._night?' night':''}" style="${st}">
        <div class="gutter"><span class="node${c?(e.hi?' ring':''):' hollow'}"></span></div>
        <div class="card">
          <div class="card-top"><span class="time">${e.time}</span>
            ${e.hi?`<span class="val off" style="color:${c}"><span class="n">Hi</span><span class="u">поза шкалою</span></span>`
              :e.glucose!=null?`<span class="val" style="color:${c}"><span class="n">${fmt(e.glucose)}</span><span class="u">ммоль/л</span></span>`
              :'<span class="no-val">без заміру</span>'}
            ${delta}
            <button class="edit" data-edit="${e.id}" aria-label="Редагувати">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
            </button></div>
          ${chips.length?`<div class="chips">${chips.join('')}</div>`:''}
          ${e.note?`<p class="note${long?' clamped':''}">${esc(e.note)}</p>`:''}
          ${e.vet?`<div class="vetnote"><span class="who">нотатка лікаря</span><p>${esc(e.vet)}</p></div>`:''}
        </div></article>`;
    });

    const shiftLbl = Math.abs(g.shift)>SHIFT_H
      ? ` <b>${g.shift>0?'+':'−'}${fmt(Math.abs(g.shift))} год</b>` : '';
    html+=`<section class="day${open?' open':''}" data-day="${g.date}">
      <button class="day-head"><div class="day-top">
        <span class="day-name">${dayName(g.date)}</span>
        <span class="day-range">${nums.length?`<i>мін–макс</i> ${fmt(Math.min(...nums))} – ${fmt(Math.max(...nums))}`:''}<span class="chev" aria-hidden="true">${CHEV}</span></span>
      </div>${g.anchor?`<div class="day-line2">від уколу ${g.anchor.time}${shiftLbl}</div>`:''}${sparkline(g)}<div class="day-meta">
        <span class="meta">${g.entries.filter(e=>e.glucose!=null||e.hi).length} замірів</span>
        ${doses.length?`<span class="meta dose">дози ${doses.join(' · ')}</span>`:'<span class="meta">без інсуліну</span>'}
        ${uml?`<span class="meta">сеча ${uml} мл</span>`:''}
        ${(()=>{const st=stoolOn(g.date);
          return st?`<span class="meta"${st.text?` title="${esc(st.text)}"`:''
            }>стул: ${esc(st.cat)}</span>`:''})()}
        ${(()=>{const m=medsOn(g.date);
          if(!m.length)return '';
          /* Решта чіпів — з малої, і назва препарату не має вибиватись:
             у цьому ряду вона така сама відмітка, як «12 замірів». */
          const uniq=[...new Set(m.map(x=>lower(medName(x))))];
          const label=uniq.length<=2?uniq.join(' · '):`${uniq.length} препарати`;
          const title=m.map(x=>`${medName(x)}${x.qty?' '+x.qty:''}${x.time?' о '+x.time:''}`).join('\n');
          return `<span class="meta" title="${esc(title)}">${esc(label)}</span>`;
        })()}
      </div></button><div class="entries">${rows}</div></section>`;
  });

  if(!chrono)html+=moreBar('journal');

  document.getElementById('main').innerHTML=html;
  bindSum();bindHint();bindMore();
  /* Розгортаємо тільки те, що натиснули: закривати сусідів і водночас кудись
     прокручувати — це й був той стрибок «не туди», бо позиція рахувалась уже
     після того, як картка вище згорталась і все з'їжджало. Тепер картка
     просто росте вниз, а сторінка лишається на місці. */
  document.querySelectorAll('.day-head').forEach(h=>h.onclick=()=>{
    const d=h.parentElement;
    const willOpen=!d.classList.contains('open');
    d.classList.toggle('open',willOpen);
    if(willOpen)openDays.add(d.dataset.day); else openDays.delete(d.dataset.day);
  });
  document.querySelectorAll('.edit').forEach(b=>b.onclick=ev=>{
    ev.stopPropagation();openEntry(b.dataset.edit)});
  document.querySelectorAll('.note.clamped, .note').forEach(n=>n.onclick=()=>
    n.classList.toggle('clamped'));

  const top=[...log].sort((a,b)=>stamp(b).localeCompare(stamp(a)))[0];
  document.getElementById('now').innerHTML=`${top.time} · <b>${top.hi?'Hi':top.glucose!=null?fmt(top.glucose):'—'}</b>`;
  const g0=chrono?groups[groups.length-1]:groups[0];
  const n0=g0.entries.filter(e=>e.glucose!=null).map(e=>e.glucose);
  document.getElementById('side').innerHTML=`
    <h3>Зараз</h3>
    <div class="big" style="color:${colorFor(top)||'var(--muted)'}">${top.hi?'Hi':top.glucose!=null?fmt(top.glucose):'—'}<span>ммоль/л · ${top.time}</span></div>
    <div class="sub">${top.hi?'поза шкалою':top.glucose!=null?bandOf(top.glucose).name:''}</div><hr>
    <h3>Поточна доба</h3><div class="sub">
      ${g0.anchor?`від уколу ${g0.anchor.time}<br>`:''}
      мін ${fmt(Math.min(...n0))} · макс ${fmt(Math.max(...n0))}<br>
      ${g0.entries.filter(e=>e.glucose!=null||e.hi).length} замірів</div>`;
  afterRender();
}

/* ================= ЗВЕДЕННЯ ================= */
let sumMode='rows';

/* цикл = від уколу до наступного уколу, разом із самим уколом */
function cyclesFull(){
  const {asc,shots}=shotsAsc();
  return shots.map((s,i)=>{
    const next=shots[i+1];
    const inside=asc.filter(e=>stamp(e)>=stamp(s)&&(!next||stamp(e)<stamp(next)));
    const after=inside.filter(e=>e!==s&&e.glucose!=null);
    const nadir=after.length?after.reduce((m,e)=>e.glucose<m.glucose?e:m):null;
    return {shot:s,slot:s._slot,dose:s.insulin,entries:inside,nadir,
      n:inside.filter(e=>e.glucose!=null||e.hi).length,
      lag:nadir?hrs(s,nadir):null,closed:!!next,dur:next?hrs(s,next):null};
  });
}
function dayCycles(){
  const days=buildDays();                       /* новіші зверху */
  const map=new Map(days.map(g=>[g.date,{date:g.date,g,am:null,pm:null}]));
  cyclesFull().forEach(c=>{
    const g=days.find(d=>d.entries.includes(c.shot));
    const k=g?g.date:c.shot.date;
    if(!map.has(k))map.set(k,{date:k,g:null,am:null,pm:null});
    map.get(k)[c.slot]=c;
  });
  return [...map.values()].sort((a,b)=>b.date.localeCompare(a.date));
}
const dateShort=iso=>{const d=new Date(iso+'T00:00:00');
  return String(d.getDate()).padStart(2,'0')+'.'+String(d.getMonth()+1).padStart(2,'0')};
function bandsLegend(){
  let lo=0;
  const items=BANDS.map(b=>{
    const label=b.max>=1e9?`${lo}+`:(lo===0?`до ${b.max}`:`${lo}–${b.max}`);
    lo=b.max;
    return `<span><i style="background:${b.color}"></i>${label}</span>`;
  }).join('');
  return `<div class="bands">${items}
    <span><i style="background:#191A1D;box-shadow:inset 0 0 0 1px var(--hairline)"></i>без заміру</span></div>`;
}


/* ---- 2. рядки: варіанти компактної таблиці, без графіків (вони вже є
   в журналі згорнутою кривою — дублювати тут по тапу сенсу нема) ---- */
/* ---- 2. рядки: доба одним рядком, ранок і вечір колонками ---- */
function cellA(c){
  if(!c)return '<div class="cell2"><span class="dash">—</span></div>';
  const pre=c.shot;
  const preV=pre.hi?'Hi':pre.glucose!=null?fmt(pre.glucose):'—';
  const dose=c.dose===0
    ?'<span class="dose-dot skip"><i></i></span>'
    :`<span class="dose-dot"><i></i>${fmt(c.dose)}</span>`;
  /* Показник іде першим і в верхньому рядку, і в нижньому: так дві цифри
     стоять точно одна під одною і колонка читається згори вниз. Стрілка чи
     слово «через» попереду зсували нижнє число вправо — і ряд починав скакати. */
  const row2=c.nadir
    ?`<span class="v2" style="color:${colorFor(c.nadir)}">${fmt(c.nadir.glucose)}</span><span class="t2">(+${Math.round(c.lag)} год)</span>`
    :c.closed?'<span class="dash">без замірів</span>':'<span class="dash">триває</span>';
  return `<div class="cell2${c.slot==='pm'?' pm':''}">
    <div class="cell2-row1"><span class="v1" style="color:${colorFor(pre)||'var(--muted)'}">${preV}</span>
      <span class="t1">(${pre.time})</span>${dose}</div>
    <div class="cell2-row2">${row2}</div></div>`;
}
/**
 * Пояснення до подання лежить під кнопкою (i) і показується лише на вимогу.
 * Само воно не вилазить: текст тут очевидний більшість днів, а віконце, яке
 * з'являється саме, доводиться закривати — тобто заважає рівно тим, хто вже
 * все зрозумів. Стан не запам'ятовується: наступного разу знову згорнуто.
 */
const SUM_HINTS={
  rows:`Кожен рядок — доба, дві колонки — ранковий і вечірній цикл.
    У клітинці зверху показник на момент уколу і доза, знизу — найнижче
    виміряне до наступного уколу.`,
  cards:`Кожна картка — доба від ранкового уколу до наступного ранкового.
    Розгорніть, щоб побачити заміри, дози, корм і ліки.`,
  uday:`Мілілітри за добу, поділені на вагу і на 24 години. Остання доба ще не
    скінчилась, тому її число завжди занижене.`,
  urows:`Час — це коли я побачила і поміняла лоток, а не коли кіт сходив.
    За одну зміну могло бути кілька разів, тому кількість записів не дорівнює
    кількості сечовипускань, а мілілітри приблизні.`
};
let hintOpen=null;

/* Сама іконка не каже, що під нею. Кружечок лишається, але поруч стоїть слово:
   тапати в невідоме заради невідомого ніхто не буде. */
function hintBtn(key){
  if(!SUM_HINTS[key])return '';
  return `<button class="ordbtn ibtn${hintOpen===key?' on':''}" data-hint="${key}"
    aria-label="Що тут показано"><i>i</i>що це</button>`;
}

/**
 * Панель відкривається всередині липкої смуги, а не десь у змісті: кнопка
 * стоїть тут, і відповідь має з'явитись тут же. Раніше текст лягав угору
 * сторінки, і з середини списку його просто не було видно — тапаєш і нічого
 * не відбувається.
 */
function hintCard(key){
  const t=SUM_HINTS[key];
  if(!t||hintOpen!==key)return '';
  return `<div class="coach">${t}</div>`;
}
function bindHint(redraw){
  document.querySelectorAll('[data-hint]').forEach(b=>
    b.onclick=()=>{const k=b.dataset.hint;
      hintOpen=hintOpen===k?null:k;(redraw||renderCycles)()});
}

function rowsView(){
  /* dayCycles() віддає новіші зверху. Порядок беремо той самий, що в журналі:
     дві таблиці про ті самі доби не мають читатись у різні боки. */
  const list=chronoNow()?[...dayCycles()].reverse():dayCycles();
  const rows=list.map(r=>`<div class="trow">
    <div class="dcell"><b>${dateShort(r.date)}</b></div>
    ${cellA(r.am)}${cellA(r.pm)}</div>`).join('');
  return `<div class="thead"><div class="trow hd"><div>Доба</div><div>Ранок</div>
      <div>Вечір</div></div></div>
    <div class="tbl">${rows}</div>`;
}

/* ---- 3. тренд передукольних ----
   Єдиний ряд, який знімається щоразу, тому він не зміщений тим, коли саме
   я вирішила поміряти. Через це його можна читати як тренд, на відміну
   від решти замірів. */
/* ---------- спільне для графічних подань ---------- */
let periodMode='7', periodFrom=null, periodTo=null;
const isoOf=d=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');

/* Обраний період може виходити за межі завантаженого. Тоді довантажуємо —
   мовчки, бо для людини це один рух «показати за все», а не дві дії. */
async function ensureRange(from){
  if(!from||!loadedFrom||from>=loadedFrom||allLoaded)return;
  const need=Math.ceil((dateOf(TODAY)-dateOf(from))/864e5)+30;
  loadingMore=true;renderCycles();
  try{
    const data=await API.load(need);
    daysWanted=Math.max(daysWanted,need);
    adopt(data);markAllLoaded(data);
  }catch(err){
    say('Не вдалося довантажити: '+esc(String(err.message||err)),'err');
  }
  loadingMore=false;renderCycles();
}
const dateOf=iso=>new Date(iso+'T00:00:00');

function periodRange(){
  const asc=[...log].sort((a,b)=>stamp(a).localeCompare(stamp(b)));
  /* Порожній журнал — не помилка, а перший день роботи з таблицею. */
  if(!asc.length){
    const t=new Date(TODAY+'T00:00:00');
    return {asc,from:t,to:t,firstMid:t,lastT:t,empty:true};
  }
  const firstMid=new Date(stamp(asc[0])); firstMid.setHours(0,0,0,0);
  const lastT=new Date(stamp(asc[asc.length-1]));
  let from,to;
  if(periodMode==='custom'){
    from=new Date((periodFrom||isoOf(firstMid))+'T00:00:00');
    to  =new Date((periodTo  ||isoOf(lastT)   )+'T23:59:59');
  }else{
    const n=periodMode==='all'?1e4:+periodMode;
    from=new Date(lastT); from.setDate(from.getDate()-n+1); from.setHours(0,0,0,0);
    to=lastT;
  }
  if(from<firstMid)from=firstMid;
  return {asc,from,to,firstMid,lastT};
}
function periodBar(){
  const {from,to,firstMid,lastT}=periodRange();
  const seg=[['7','7 днів'],['14','14 днів'],['all','Усе'],['custom','Свій']].map(([k,l])=>
    `<button data-pm="${k}" class="${periodMode===k?'on':''}">${l}</button>`).join('');
  const picker=periodMode==='custom'
    ? `<div class="dtrange"><input type="date" id="pFrom" value="${periodFrom||isoOf(from)}"
         min="${isoOf(firstMid)}" max="${isoOf(lastT)}">
       <span>—</span>
       <input type="date" id="pTo" value="${periodTo||isoOf(to)}"
         min="${isoOf(firstMid)}" max="${isoOf(lastT)}"></div>` : '';
  return `<div class="seg-in">${seg}</div>${picker}`;
}
const lg=(svg,txt)=>`<span>${svg} ${txt}</span>`;
const legendRow=items=>`<div class="legend">${items.join('')}</div>`;

/* ---- 3. динаміка ---- */
const LOW_FROM=3, LOW_TO=7;
let lowWindow=true;

/**
 * Ширина полотна в тих самих пікселях, у яких воно буде на екрані.
 * Раніше viewBox був фіксовані 600 одиниць, а svg розтягувався на ширину
 * контейнера — на телефоні це стиснення вдвічі, і разом з геометрією вдвічі
 * стискались підписи: 9.5 кегля перетворювались на 5. Тому полотно міряємо,
 * а не вигадуємо: одна одиниця viewBox = один піксель, і кегль означає кегль.
 */
function chartW(){
  const m=document.getElementById('main');
  const pad=parseFloat(getComputedStyle(document.body).getPropertyValue('--pad'))||14;
  /* поля .chart-box: pad ліворуч і праворуч, 16 внутрішніх і рамка */
  return Math.max(280,Math.round((m?m.clientWidth:360)-2*pad-34));
}

/* Підпис дати займає приблизно стільки; рідше — краще, ніж злиплий ряд. */
const DATE_PX=40;
/* Крок підписів вибираємо з «людських» значень: 5 днів або 9 днів між
   позначками читаються гірше, ніж тиждень, навіть якщо влізають. */
const STRIDES=[1,2,3,7,14,30];
const strideFor=perDay=>STRIDES.find(s=>s*perDay>=DATE_PX+6)||STRIDES[STRIDES.length-1];

function trendChart(pts,opt){
  const W=opt.W||chartW(),H=opt.H||250,pl=30,pr=24,pt=12,dose=40,dates=18,mY=30;
  const pb=dose+dates;
  const X=i=>pl+(pts.length<2?0.5*(W-pl-pr):i/(pts.length-1)*(W-pl-pr));
  const Y=v=>H-pb-(Math.min(v,mY)/mY)*(H-pb-pt);
  const base=H-dates-4, maxDose=Math.max(0.75,...pts.map(p=>p.dose||0));
  const bw=Math.max(5,Math.min(16,(W-pl-pr)/Math.max(pts.length,1)*0.4));
  let g=`<rect x="${pl}" y="${Y(15)}" width="${W-pl-pr}" height="${Y(5)-Y(15)}"
    fill="${BANDS[2].color}" opacity=".08"/>`;
  [5,10,15,20,25,30].forEach(v=>{
    g+=`<line x1="${pl}" y1="${Y(v)}" x2="${W-pr}" y2="${Y(v)}" stroke="var(--hairline)"
      stroke-width="1" opacity=".55"/>
      <text x="${pl-6}" y="${Y(v)+4}" text-anchor="end" font-size="10.5" fill="var(--faint)">${v}</text>`;});
  for(let i=1;i<pts.length;i++){
    if(pts[i].v==null||pts[i-1].v==null)continue;
    g+=`<line x1="${X(i-1)}" y1="${Y(pts[i-1].v)}" x2="${X(i)}" y2="${Y(pts[i].v)}"
      stroke="${pts[i].col}" stroke-width="2" opacity=".85" stroke-linecap="round"/>`;
  }
  /* Підписи ставимо жадібно: наступна дата малюється, лише якщо від
     попередньої лишилось місце. Рахувати «кожну N-ту» тут не можна — точки
     стоять за індексом, а не за часом, і варто десь бракувати вечірнього
     уколу, як дві сусідні дати опиняються впритул і наїжджають одна на одну. */
  let lastLx=-1e9;
  pts.forEach((p,i)=>{
    const x=X(i);
    if(p.v!=null){
      g+= p.slot==='am'
        ? `<circle cx="${x}" cy="${Y(p.v)}" r="4.6" fill="${p.col}"/>`
        : `<circle cx="${x}" cy="${Y(p.v)}" r="4.2" fill="var(--card)" stroke="${p.col}" stroke-width="2"/>`;
      if(p.hi)g+=`<circle cx="${x}" cy="${Y(p.v)}" r="8" fill="none" stroke="${p.col}"
        stroke-width="1.4" opacity=".7" stroke-dasharray="2.2 2.2"/>`;
    }
    if(p.dose===0){
      g+=`<line x1="${x-bw/2}" y1="${base}" x2="${x+bw/2}" y2="${base}"
        stroke="var(--faint)" stroke-width="2" stroke-dasharray="2 2.5" opacity=".8"/>`;
    }else if(p.dose!=null){
      const h=Math.max(3,(p.dose/maxDose)*(dose-10));
      g+=`<rect x="${x-bw/2}" y="${base-h}" width="${bw}" height="${h}" rx="2"
        fill="${C_INS}" opacity="${p.slot==='am'?.95:.55}"><title>${fmt(p.dose)} ОД</title></rect>`;
    }
    if(p.label&&x-lastLx>=DATE_PX){
      lastLx=x;
      g+=`<text x="${x}" y="${H-4}" text-anchor="middle" font-size="11"
        fill="var(--faint)">${p.label}</text>`;
    }
  });
  g+=`<line x1="${pl}" y1="${base}" x2="${W-pr}" y2="${base}"
    stroke="var(--hairline)" stroke-width="1"/>`;
  return `<svg viewBox="0 0 ${W} ${H}">${g}</svg>`;
}

function trendView(){
  const {from,to}=periodRange();
  const cyc=cyclesFull().filter(c=>{const t=new Date(stamp(c.shot));return t>=from&&t<=to});
  const bar=periodBar();
  if(cyc.length<2)return bar+'<div class="sum-note">Замало даних за цей період.</div>';
  const B=BANDS[2].color;
  const legend=legendRow([
    lg(`<svg width="12" height="12"><circle cx="6" cy="6" r="4.2" fill="${B}"/></svg>`,'ранок'),
    lg(`<svg width="12" height="12"><circle cx="6" cy="6" r="3.6" fill="none" stroke="${B}" stroke-width="2"/></svg>`,'вечір'),
    lg(`<svg width="14" height="12"><circle cx="7" cy="6" r="2.4" fill="${BANDS[4].color}"/><circle cx="7" cy="6" r="5.2" fill="none" stroke="${BANDS[4].color}" stroke-width="1.2" stroke-dasharray="2.2 2.2"/></svg>`,'Hi'),
    lg(`<svg width="12" height="12"><rect x="3" y="2" width="6" height="9" rx="1.5" fill="${C_INS}"/></svg>`,'доза'),
    lg(`<svg width="14" height="12"><line x1="2" y1="6" x2="12" y2="6" stroke="var(--faint)" stroke-width="2" stroke-dasharray="2 2.5"/></svg>`,'укол не робили'),
    lg(`<svg width="16" height="12"><rect x="1" y="3" width="14" height="6" fill="${B}" opacity=".22"/></svg>`,'5–15 ммоль/л'),
  ]);
  const base=c=>({slot:c.slot,dose:c.dose,label:c.slot==='am'?dateShort(c.shot.date):''});
  const pre=cyc.filter(c=>c.shot.glucose!=null||c.shot.hi).map(c=>Object.assign(base(c),{
    v:c.shot.hi?30:c.shot.glucose, hi:!!c.shot.hi, col:colorFor(c.shot)}));
  const lowOf=c=>{
    const pool=c.entries.filter(e=>e!==c.shot&&e.glucose!=null&&
      (!lowWindow||(hrs(c.shot,e)>=LOW_FROM&&hrs(c.shot,e)<=LOW_TO)));
    return pool.length?pool.reduce((m,e)=>e.glucose<m.glucose?e:m):null;
  };
  const low=cyc.map(c=>{const n=lowOf(c);
    return Object.assign(base(c),{v:n?n.glucose:null,hi:false,
      col:n?colorFor(n):'var(--faint)'})});
  const shown=low.filter(p=>p.v!=null).length;
  const seg=[[true,`+${LOW_FROM}…+${LOW_TO} год`],[false,'будь-коли']].map(([k,l])=>
    `<button data-lw="${k}" class="${lowWindow===k?'on':''}">${l}</button>`).join('');

  return bar+legend+`<section class="chart-box">
      <h4>Глюкоза на момент уколу</h4>
      ${trendChart(pre,{H:250})}
    </section>
    <section class="chart-box">
      <h4>Найнижче в циклі</h4>
      <div class="cap">Найменше з виміряного після уколу. Заміри нерегулярні,
        тому це не обов'язково справжній мінімум.</div>
      <div class="seg-in" style="margin-left:0;margin-right:0">${seg}</div>
      ${trendChart(low,{H:250})}
      <div class="scroll-hint">Точок із даними: ${shown} з ${low.length}.</div>
    </section>`;
}

/* ---- 4. крива за період ---- */
function periodView(){
  const {asc,from,to}=periodRange();
  const bar=periodBar();
  const inRange=asc.filter(e=>{const t=new Date(stamp(e));return t>=from&&t<=to});
  if(inRange.length<2)return bar+'<div class="sum-note">Замало даних за цей період.</div>';

  const B=BANDS[2].color;
  const t0=from, t1=new Date(stamp(inRange[inRange.length-1]));
  const totalH=Math.max(24,(t1-t0)/36e5);
  const nDays=Math.ceil(totalH/24);
  const agg=nDays>21;
  /* Довгий період не обрізаємо, а стискаємо: на «Усе» за півроку добових
     стовпчиків буде 180, і при 22 px кожен полотно вийшло б у чотири тисячі
     пікселів. Тому крок дня зменшується, а ширина впирається в стелю. */
  const perDay=agg?Math.max(5,Math.min(22,Math.round(4200/Math.max(nDays,1)))):150;
  const W=Math.max(560,Math.round(nDays*perDay));
  const H=245, pl=30,pr=12,pt=12,pb=46,mY=30;
  const X=d=>pl+((d-t0)/36e5)/totalH*(W-pl-pr);
  const Y=v=>H-pb-(Math.min(v,mY)/mY)*(H-pb-pt);
  const at=e=>new Date(stamp(e));

  let g=`<rect x="${pl}" y="${Y(15)}" width="${W-pl-pr}" height="${Y(5)-Y(15)}"
    fill="${B}" opacity=".08"/>`;
  [5,10,15,20,25,30].forEach(v=>{
    g+=`<line x1="${pl}" y1="${Y(v)}" x2="${W-pr}" y2="${Y(v)}" stroke="var(--hairline)"
      stroke-width="1" opacity=".55"/>
      <text x="${pl-6}" y="${Y(v)+4}" text-anchor="end" font-size="10.5" fill="var(--faint)">${v}</text>`;});
  /* Крок підписів рахуємо від ширини доби, а не від того, стиснений період чи
     ні: інакше на піврічному вікні, де доба займає п'ять пікселів, тижневі
     позначки злипаються в суцільну смугу. */
  let di=0; const labelEvery=strideFor(W/Math.max(nDays,1));
  for(let d=new Date(t0);d<=t1;d.setDate(d.getDate()+1),di++){
    const x=X(d), show=di%labelEvery===0;
    if(show||!agg)
      g+=`<line x1="${x}" y1="${pt}" x2="${x}" y2="${H-pb}" stroke="var(--hairline)" stroke-width="1"/>`;
    if(show)
      g+=`<text x="${x+5}" y="${H-12}" font-size="11" fill="var(--faint)">${
        isoOf(d).slice(8)+'.'+isoOf(d).slice(5,7)}</text>`;
  }

  if(agg){
    const byDay=new Map();
    inRange.filter(e=>e.glucose!=null||e.hi).forEach(e=>{
      if(!byDay.has(e.date))byDay.set(e.date,[]); byDay.get(e.date).push(e)});
    [...byDay.entries()].forEach(([date,list])=>{
      const vals=list.map(e=>e.hi?mY:e.glucose);
      const mn=Math.min(...vals), mx=Math.max(...vals);
      const x=X(new Date(date+'T12:00:00'));
      const worst=list.reduce((a,b)=>((b.hi?mY:b.glucose)>(a.hi?mY:a.glucose)?b:a));
      g+=`<line x1="${x}" y1="${Y(mn)}" x2="${x}" y2="${Y(mx)}" stroke="${colorFor(worst)}"
        stroke-width="4" stroke-linecap="round" opacity=".55"/>`;
      const shot=list.find(e=>e.insulin!=null&&e._slot==='am');
      if(shot)g+=`<circle cx="${x}" cy="${Y(shot.hi?mY:shot.glucose)}" r="2.6" fill="${colorFor(shot)}"/>`;
      if(list.some(e=>e.hi))g+=`<circle cx="${x}" cy="${Y(mY)}" r="5.4" fill="none"
        stroke="${BANDS[BANDS.length-1].color}" stroke-width="1.3" opacity=".7" stroke-dasharray="2.2 2.2"/>`;
    });
    const legendA=legendRow([
      lg(`<svg width="10" height="14"><line x1="5" y1="1" x2="5" y2="13" stroke="${B}" stroke-width="3.5" stroke-linecap="round" opacity=".6"/></svg>`,'мін–макс за добу'),
      lg(`<svg width="12" height="12"><circle cx="6" cy="6" r="2.6" fill="${B}"/></svg>`,'перед ранковим уколом'),
      lg(`<svg width="14" height="12"><circle cx="7" cy="6" r="5" fill="none" stroke="${BANDS[4].color}" stroke-width="1.2" stroke-dasharray="2.2 2.2"/></svg>`,'був Hi'),
    ]);
    return bar+legendA+`<section class="chart-box">
      <h4>Добові діапазони</h4>
      <div class="cap">Період довший за три тижні, тому показано не кожен замір,
        а розмах за добу.</div>
      <div class="scrollx"><svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${g}</svg></div>
      ${W>560?'<div class="scroll-hint">Гортається вбік.</div>':''}
    </section>`;
  }

  const pts=inRange.filter(e=>e.glucose!=null||e.hi).map(e=>({e,v:e.hi?mY:e.glucose}));
  for(let i=1;i<pts.length;i++){
    const gap=hrs(pts[i-1].e,pts[i].e)>GAP_H;
    g+=`<line x1="${X(at(pts[i-1].e))}" y1="${Y(pts[i-1].v)}" x2="${X(at(pts[i].e))}" y2="${Y(pts[i].v)}"
      stroke="${colorFor(pts[i].e)}" stroke-width="2" stroke-linecap="round"
      ${gap?'stroke-dasharray="2.5 5" opacity=".4"':''}/>`;
  }
  inRange.filter(e=>e.insulin!=null).forEach(e=>{
    g+=`<line x1="${X(at(e))}" y1="${H-pb}" x2="${X(at(e))}" y2="${H-pb-13}"
      stroke="${C_INS}" stroke-width="2.6" stroke-linecap="round"
      ${e.insulin===0?'stroke-dasharray="2 3" opacity=".5"':''}/>`;});
  inRange.filter(e=>e.food).forEach(e=>{
    const x=X(at(e)),y=H-pb+9,r=3.4;
    g+=`<path d="M${x} ${y-r} L${x+r} ${y} L${x} ${y+r} L${x-r} ${y} Z" fill="${C_FOOD}"/>`;});
  pts.forEach(p=>{
    const c=colorFor(p.e),x=X(at(p.e)),y=Y(p.v);
    g+=`<circle cx="${x}" cy="${y}" r="3.4" fill="${c}"/>`;
    if(p.e.hi)g+=`<circle cx="${x}" cy="${y}" r="6.6" fill="none" stroke="${c}"
      stroke-width="1.4" opacity=".7" stroke-dasharray="2.2 2.2"/>`;
  });

  const legendB=legendRow([
    lg(`<svg width="12" height="12"><circle cx="6" cy="6" r="3.4" fill="${B}"/></svg>`,'замір'),
    lg(`<svg width="18" height="10"><line x1="1" y1="5" x2="17" y2="5" stroke="${B}" stroke-width="2" stroke-dasharray="2.5 3" opacity=".55"/></svg>`,`понад ${GAP_H} год без замірів`),
    lg(`<svg width="10" height="12"><rect x="3.5" y="1" width="3" height="10" rx="1.5" fill="${C_INS}"/></svg>`,'укол'),
    lg(`<svg width="12" height="12"><path d="M6 2 L10 6 L6 10 L2 6 Z" fill="${C_FOOD}"/></svg>`,'корм'),
    lg(`<svg width="14" height="12"><circle cx="7" cy="6" r="2.4" fill="${BANDS[4].color}"/><circle cx="7" cy="6" r="5.2" fill="none" stroke="${BANDS[4].color}" stroke-width="1.2" stroke-dasharray="2.2 2.2"/></svg>`,'Hi'),
  ]);
  return bar+legendB+`<section class="chart-box">
      <h4>Усі заміри за період</h4>
      <div class="cap">Реальна шкала часу, вертикалі — межі діб.</div>
      <div class="scrollx"><svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${g}</svg></div>
      ${W>560?'<div class="scroll-hint">Гортається вбік.</div>':''}
    </section>`;
}

/**
 * Смуга подань «Зведення» — спільна для карток і решти подань.
 * Липка разом з керуванням: перемикач подань потрібен посеред списку не рідше,
 * ніж на його початку, а гортати заради нього до самого верху — та ще розвага.
 */
function sumBar(){
  const modes=[['cards','Картками'],['rows','По добах'],
               ['trend','Динаміка'],['period','Крива']];
  const seg=`<div class="seg-top">${modes.map(([k,l])=>
    `<button data-m="${k}" class="${sumMode===k?'on':''}">${l}</button>`).join('')}</div>`;
  /* Порядок стосується лише списків; у графіках вісь задає сама себе. */
  const ctrl=(sumMode==='rows'||sumMode==='cards')
    ? `<div class="jrow">${orderBtn()}${hintBtn(sumMode)}</div>` : '';
  return `<div class="stick">${seg}${ctrl}${hintCard(sumMode)}</div>`;
}
function bindSum(){
  document.querySelectorAll('.seg-top [data-m]').forEach(b=>
    b.onclick=()=>{sumMode=b.dataset.m;needScroll=true;renderCycles()});
}

function renderCycles(){
  if(sumMode==='cards')return renderCards();
  beginRender();
  /* «Години» прибрано: на телефоні сітка годин не читається, а обробка зсувів
     уколів у ній сумнівна. Код лишився в історії — див. docs/navigation.md. */
  const modes=[['cards','Картками'],['rows','По добах'],
               ['trend','Динаміка'],['period','Крива']];
  const views={rows:rowsView,trend:trendView,period:periodView};
  /* «По добах» іде старішим угору, тому там кнопка згори; у графічних
     поданнях вона просто дія під змістом. */
  /* У графічних поданнях кнопки «показати ще» немає навмисно: там період
     обирається зверху, і якщо даних на нього бракує — вони підвантажаться самі
     при виборі. Окрема кнопка поруч із вибором періоду тільки збиває. */
  /* Кнопка стоїть там, куди гортаєш за старішим: угорі при хронологічному
     порядку і внизу при зворотному. Це та сама логіка, що в журналі. */
  const more=sumMode==='rows'?moreBar('journal'):'';
  const chrono=chronoNow();
  document.getElementById('main').innerHTML=sumBar()
    +(chrono?more:'')+views[sumMode]()+(chrono?'':more);
  bindSum();bindHint();
  if(sumMode==='rows'){bindOrder();bindMore();}
  afterRender();
  document.querySelectorAll('[data-lw]').forEach(b=>
    b.onclick=()=>{lowWindow=b.dataset.lw==='true';renderCycles()});
  document.querySelectorAll('[data-pm]').forEach(b=>
    b.onclick=()=>{
      periodMode=b.dataset.pm;
      renderCycles();
      ensureRange(periodRange().from);   /* даних може не вистачати — довантажимо */
    });
  const pf=document.getElementById('pFrom'), ptv=document.getElementById('pTo');
  if(pf)pf.onchange=()=>{periodFrom=pf.value;renderCycles()};
  if(ptv)ptv.onchange=()=>{periodTo=ptv.value;renderCycles()};

  /* тут був список ранкових замірів через крапку — ряд чисел нічого не давав */
  document.getElementById('side').innerHTML='';
}

/**
 * Вага для розрахунку мл/кг/год.
 *
 * Живе у властивостях скрипта, а не колонкою в аркуші, навмисно. Це не вимір:
 * кота зважують коли-не-коли на вагах, яким ніхто не вірить. Колонка на кожну
 * добу перетворила б одне приблизне число на дані, які треба вести — і які,
 * якщо вага виявиться кривою, довелося б правити заднім числом по всіх добах.
 * Тут це множник у формулі: одне значення, два тапи, однакове на всіх
 * пристроях і в лікарки.
 *
 * Копія лежить у localStorage, щоб число було на екрані до відповіді скрипта
 * і щоб не показувати чужу цифру, коли мережі немає.
 */
const WEIGHT_KEY='venya.weight';
const weight=()=>{
  const w=parseFloat(serverWeight||localStorage.getItem(WEIGHT_KEY));
  return w>0&&w<30?w:5;
};
const kgText=()=>String(weight()).replace('.',',');

/* Доби розділу — за спільним сортуванням, тим самим, що в журналі. */
function urineDays(){
  const all=[...new Set([...urine.map(u=>u.date),...stool.map(s=>s.date)])].sort();
  return chronoNow()?all:all.reverse();
}
const mlOn=date=>urine.filter(u=>u.date===date).reduce((s,u)=>s+u.ml,0);
/* Мілілітри за добу, поділені на вагу і на 24 години. Поточна доба ще не
   скінчилась, тому її число завжди занижене — його показуємо приглушено. */
const rateOn=date=>mlOn(date)/weight()/24;
const rate1=r=>r.toFixed(1).replace('.',',');

/**
 * Доба одним рядком. Кількості змін лотка тут немає навмисно: вона нічого не
 * каже про кота — за одну зміну могло бути і одне сечовипускання, і три. Бал
 * Пуріни теж прибраний: верхнім індексом його однаково не видно, а окремою
 * колонкою він не вартий ширини. І те, й інше лишається в «Записах».
 */
function urineDaysView(){
  const list=urineDays().filter(d=>mlOn(d)>0||stoolOn(d));
  if(!list.length)return '<div class="empty">Записів ще немає.</div>';
  const full=list.filter(d=>d!==TODAY&&mlOn(d)>0);
  const avg=full.length?full.reduce((s,d)=>s+rateOn(d),0)/full.length:null;
  const rows=list.map(date=>{
    const ml=mlOn(date), st=stoolOn(date), today=date===TODAY;
    const r=ml?rateOn(date):null;
    return `<div class="urow${today?' part':''}">
      <div class="dcell"><b>${dateShort(date)}</b></div>
      <div class="ust">${st&&st.cat?esc(st.cat):'<span class="dash">—</span>'}</div>
      <div class="uv">${ml?`<b>${ml}</b> мл`:'<span class="dash">—</span>'}</div>
      <div class="urate"${today?' title="доба ще не скінчилась"':''}>${
        r!=null?`<b>${rate1(r)}</b>`:'<span class="dash">—</span>'}</div>
    </div>`;
  }).join('');
  /* Слова ліворуч, числа праворуч: погляд іде по датах униз, а колонки цифр
     лишаються суцільними — так їх можна порівнювати, не читаючи. */
  return `${avg!=null?`<div class="sum-note">За ${full.length} ${
      plural(full.length,'повну добу','повні доби','повних діб')} в середньому
      <b>${rate1(avg)}</b> мл/кг/год.</div>`:''}
    <div class="thead"><div class="urow hd"><div>Доба</div><div>Стул</div>
      <div>Сеча</div><div>мл/кг/год</div></div></div>
    <div class="tbl">${rows}</div>`;
}

function openWeight(){
  shell('Вага для розрахунку',`
    <div class="field"><label for="w-kg">Кілограми</label>
      <input id="w-kg" type="text" inputmode="decimal"
        value="${kgText()}"></div>
    <div class="hint">Тільки для розрахунку мл/кг/год. Одне число на всі доби,
      історія не ведеться: виправили — і всі підрахунки стали за новою вагою.</div>`);
  document.getElementById('saveBtn').onclick=async()=>{
    const n=parseFloat((document.getElementById('w-kg').value||'').replace(',','.'));
    if(!(n>0&&n<30)){close();return}
    /* Показуємо одразу, зберігаємо слідом: якщо скрипт відмовить, кажемо це
       вголос, а не лишаємо на екрані число, якого на сервері немає. */
    serverWeight=n;localStorage.setItem(WEIGHT_KEY,String(n));
    close();renderUrine();
    try{ await API.setWeight(n); }
    catch(err){
      const m=String(err.message||err);
      /* Старий скрипт не знає такої дії. Це не помилка запису, а різниця
         версій, і сказати про неї треба саме так — інакше людина шукає
         поламане там, де просто не оновлений скрипт. */
      say(m.indexOf('unknown sheet')>=0||m.indexOf('unknown action')>=0
        ?'Вага збережена лише на цьому пристрої — у таблиці ще старий скрипт'
        :'Вагу не збережено: '+esc(m),'err');
    }
  };
}
function bindWeight(){
  const b=document.querySelector('[data-w]');
  if(b)b.onclick=openWeight;
}

/* «За добу» першим: у цей розділ заходять із питанням «скільки за добу», а не
   «коли міняла лоток». Записи лишаються там, де в них є потреба. */
let urineMode='days';
function urineBar(){
  const seg=`<div class="seg-top">${[['days','За добу'],['rows','Записи']]
    .map(([k,l])=>`<button data-u="${k}" class="${urineMode===k?'on':''}">${l}</button>`)
    .join('')}</div>`;
  const w=urineMode==='days'
    ? `<button class="ordbtn wbtn" data-w>вага ${kgText()} кг</button>` : '';
  const key=urineMode==='days'?'uday':'urows';
  return `<div class="stick">${seg}<div class="jrow">${orderBtn()}${w}${
    hintBtn(key)}</div>${hintCard(key)}</div>`;
}
function renderUrine(){
  beginRender();
  const bar=urineBar(), more=moreBar('urine'), chrono=chronoNow();
  document.getElementById('side').innerHTML='';
  if(urineMode==='days'){
    document.getElementById('main').innerHTML=
      bar+(chrono?more:'')+urineDaysView()+(chrono?'':more);
    bindMore();bindWeight();bindUrineMode();bindOrder();
    bindHint(renderUrine);afterRender();
    return;
  }
  let html=bar+(chrono?more:'');
  urineDays().forEach(date=>{
    const list=urine.filter(u=>u.date===date)
      .sort((a,b)=>chrono?a.time.localeCompare(b.time):b.time.localeCompare(a.time));
    const total=list.reduce((s,u)=>s+u.ml,0);
    html+=`<section class="u-day">
      <div class="u-top"><span class="day-name">${dayName(date)}</span>
        <span class="u-total"><span>за добу прибл.</span>${total} мл</span></div>
      <div class="u-chips">${list.map(u=>`<span class="u-chip" data-uedit="${u.id}">${u.time}<b>${u.ml}</b></span>`).join('')}</div>
      ${(()=>{const st=stoolOn(date);
        return st?`<div class="stool">стул: <b>${esc(st.cat)}</b>${
          st.text?' — '+esc(st.text):''}</div>`:''})()}
    </section>`;
  });
  document.getElementById('main').innerHTML=html+(chrono?'':more);
  bindMore();bindUrineMode();bindOrder();bindHint(renderUrine);
  document.querySelectorAll('[data-uedit]').forEach(c=>c.onclick=()=>openUrine(c.dataset.uedit));
  afterRender();
}
function bindUrineMode(){
  /* Зміна подання — це той самий захід у розділ: стаємо на найсвіжіші. */
  document.querySelectorAll('.seg-top [data-u]').forEach(b=>
    b.onclick=()=>{urineMode=b.dataset.u;needScroll=true;renderUrine()});
}

/* Курс = призначення. Прийоми до нього прив'язані, тому повторне призначення
   того ж препарату — окрема картка з власною статистикою. */
const dmy=iso=>{const d=new Date(iso+'T00:00:00');
  return String(d.getDate()).padStart(2,'0')+'.'+String(d.getMonth()+1).padStart(2,'0')};

/* Картка курсу відповідає на «чи триває і коли давала востаннє» — на це
   вистачає двох дат. Лічильника прийомів тут нема навмисно: він рахувався б по
   завантаженому вікну, тобто мовчки брехав би для курсів, що почались раніше.
   «Скільки всього» — питання рідке, і таблиця відповість на нього точніше. */
const plural=(n,one,few,many)=>{
  const a=Math.abs(n)%100, b=a%10;
  if(a>10&&a<20)return many;
  if(b>1&&b<5)return few;
  return b===1?one:many;
};

function courseStats(r){
  const list=meds.filter(m=>m.rid===r.id).sort((a,b)=>a.date.localeCompare(b.date));
  /* Для завершеного курсу «востаннє» дублювало б дату кінця, тому там
     показуємо тривалість — щоб не віднімати дати в голові. */
  const span=r.to&&r.from
    ? Math.round((dateOf(r.to)-dateOf(r.from))/864e5)+1 : null;
  return {list, last:list.length?list[list.length-1].date:null,
          active:!r.to, span};
}

function courseCard(r){
  const st=courseStats(r);
  const rows=[...st.list].reverse().slice(0,5).map(m=>
    `<div class="mrow" data-medit="${m.id}">
      <span class="md">${dmy(m.date)}</span>
      <span class="mq">${esc(m.qty||'')}</span>
      <span class="mt">${m.time||''}</span>
      ${m.note?`<span class="mn">${esc(m.note)}</span>`:''}
    </div>`).join('');
  return `<section class="med">
    <div class="med-top">
      <span class="day-name">${esc(r.name)}</span>
      <span class="med-state${st.active?' on':''}">${st.active?'триває':'завершено'}</span>
    </div>
    <div class="sub">${dmy(r.from)} – ${st.active?'досі':dmy(r.to)}${
      st.active
        ? (st.last?` · востаннє ${dmy(st.last)}`:'')
        : (st.span?` · ${st.span} ${plural(st.span,'день','дні','днів')}`:'')}${
      r.note?`<br>${esc(r.note)}`:''}</div>
    ${rows?`<div class="mlist">${rows}</div>`:''}
    ${st.list.length>5?`<div class="mmore">показано останні 5</div>`:''}
    ${API.canWrite()?`<div class="card-acts">
      <button class="btn ghost small" data-redit="${r.id}">Змінити призначення</button>
      ${st.active?`<button class="btn ghost small" data-endr="${r.id}">Завершити курс</button>`:''}
    </div>`:''}
  </section>`;
}

function renderMeds(){
  beginRender();
  const act=regimens.filter(r=>!r.to).sort((a,b)=>b.from.localeCompare(a.from));
  const past=regimens.filter(r=>r.to).sort((a,b)=>b.to.localeCompare(a.to));

  document.getElementById('main').innerHTML=`
    <button class="more-item" data-more="back" style="border:0;padding:14px 2px;
      margin:0 var(--pad)">← Ще</button>
    <div class="med-acts">
      ${API.canWrite()?`<button class="btn ghost" id="addReg">Нове призначення</button>
      <button class="btn ghost" id="addMed">Окремий прийом</button>`:''}
    </div>
    ${act.map(courseCard).join('')}
    ${past.length?`<details class="past"><summary>Завершені курси (${past.length})
      <span class="mb-chev">${CHEV}</span></summary>
      ${past.map(courseCard).join('')}</details>`:''}
    ${moreBar('meds')}`;
  bindMore();
  document.getElementById('side').innerHTML='';
  const back=document.querySelector('[data-more="back"]');
  if(back)back.onclick=()=>{moreMode=null;needScroll=true;renderMore()};
  document.querySelectorAll('[data-medit]').forEach(r=>r.onclick=()=>openMed(r.dataset.medit));
  document.querySelectorAll('[data-redit]').forEach(b=>
    b.onclick=()=>openRegimen(+b.dataset.redit));
  document.querySelectorAll('[data-endr]').forEach(b=>b.onclick=()=>{
    const r=regimens.find(x=>x.id===+b.dataset.endr);
    const last=meds.filter(m=>m.rid===r.id).map(m=>m.date).sort().pop();
    r.to=last||TODAY;
    API.update('regimen',r.id,{to:r.to});   /* раніше правилось лише на екрані */
    renderMeds();
  });
  const bReg=document.getElementById('addReg'), bMed=document.getElementById('addMed');
  if(bReg)bReg.onclick=()=>openRegimen();
  if(bMed)bMed.onclick=()=>openMed();
  afterRender();
}

function openRegimen(id){
  if(shotMode||!API.canWrite())return;
  const r=id?regimens.find(x=>x.id===id):{from:TODAY};
  editing=id||null;
  shell(id?'Змінити призначення':'Нове призначення',`
    <div class="field"><label for="r-name">Препарат</label>
      <input id="r-name" type="text" value="${esc(r.name)}" placeholder="Клавасептин"></div>
    <div class="row2">
      <div class="field"><label for="r-from">Початок</label>
        <input id="r-from" type="date" value="${r.from||TODAY}"></div>
      <div class="field"><label for="r-to">Кінець</label>
        <input id="r-to" type="date" value="${r.to||''}">
        <div class="hint">порожньо = триває</div></div>
    </div>
    <div class="field"><label for="r-note">Схема і нотатка</label>
      <textarea id="r-note" placeholder="1/2 табл. двічі на день, за півгодини до їжі">${esc(r.note)}</textarea>
      <div class="hint">Скільки й скільки разів — сюди вільним текстом: доза
        коригується по ходу, а що реально дали — видно з прийомів.</div></div>
    <div class="hint">Якщо той самий препарат призначать удруге, заводь нове призначення —
      тоді курси рахуватимуться окремо, а не зіллються в один.</div>`,
    id?()=>{API.remove('regimen',id);regimens=regimens.filter(x=>x.id!==id);close();renderMeds()}:null);
  document.getElementById('saveBtn').onclick=()=>{
    /* Кількості й «разів на день» тут немає навмисно: цих колонок в аркуші
       більше не існує, і раніше форма збирала їх у нікуди. */
    const data={name:document.getElementById('r-name').value.trim(),
      note:document.getElementById('r-note').value.trim(),
      from:document.getElementById('r-from').value||TODAY,
      to:document.getElementById('r-to').value||null};
    if(!data.name){close();return}
    if(editing){Object.assign(regimens.find(x=>x.id===editing),data);API.update('regimen',editing,data)}
    else{
      /* id призначення — маленьке число, бо на нього посилаються рядки ліків */
      const nid=regimens.reduce((m,r)=>Math.max(m,r.id||0),300)+1;
      regimens.push({id:nid,...data});
      API.create('regimen',nid,{...data,id:nid});
    }
    close();renderMeds();
  };
}

function openMed(id){
  if(shotMode||!API.canWrite())return;
  const m=id?meds.find(x=>x.id===id):{date:TODAY,rid:(activeRegimens()[0]||{}).id};
  editing=id||null;
  const opts=regimens.map(r=>
    `<option value="${r.id}"${r.id===m.rid?' selected':''}>${esc(r.name)}${r.to?' (завершено)':''}</option>`).join('');
  shell(id?'Змінити прийом':'Окремий прийом',`
    <div class="field"><label for="m-rid">Призначення</label>
      <select id="m-rid">${opts}</select></div>
    <div class="row2">
      <div class="field"><label for="m-date">Дата</label>
        <input id="m-date" type="date" value="${m.date||TODAY}"></div>
      <div class="field"><label for="m-time">Час</label>
        ${timeInput('','m',m.time||'')}
        <div class="hint">можна лишити порожнім</div></div>
    </div>
    <div class="field"><label for="m-qty">Кількість</label>
      <input id="m-qty" type="text" value="${esc(m.qty||(m.rid?lastQty(m.rid):''))}" placeholder="1/10 ч.л."></div>
    <div class="field"><label for="m-note">Нотатка</label>
      <input id="m-note" type="text" value="${esc(m.note)}" placeholder="чому змінила, побічка"></div>`,
    id?()=>{API.remove('med',id);meds=meds.filter(x=>x.id!==id);close();renderMeds()}:null);
  bindTime('m');
  document.getElementById('saveBtn').onclick=()=>{
    const time=(document.getElementById('m-time').value||'').trim();
    const data={rid:+document.getElementById('m-rid').value,
      date:document.getElementById('m-date').value||TODAY,
      time:time?readTime('m'):undefined,
      qty:document.getElementById('m-qty').value.trim(),
      note:document.getElementById('m-note').value.trim()||undefined};
    const row={date:data.date,time:data.time||'',name:regOf(data.rid).name,
      qty:data.qty,note:data.note||'',regimenId:data.rid};
    if(editing){Object.assign(meds.find(x=>x.id===editing),data);API.update('med',editing,row)}
    else{const nid=API.uid('m');meds.push({id:nid,...data});API.create('med',nid,row)}
    close();renderMeds();
  };
}

const scrim=document.getElementById('scrim'),sheet=document.getElementById('sheet'),body=document.getElementById('sheetBody');
const nowTime=()=>{const n=new Date();return String(n.getHours()).padStart(2,'0')+':'+String(n.getMinutes()).padStart(2,'0')};
/* Одне поле з маскою: двокрапка проставляється сама після двох цифр.
   Поточний час стоїть підказкою, а не значенням — якщо не чіпати поле,
   запис піде цим часом, але й переписати його можна одним рухом. */
function timeInput(now,pfx='f',val=''){
  return `<input id="${pfx}-time" class="time-mask" inputmode="numeric" maxlength="5"
    placeholder="${now}" value="${val}" aria-label="Час">`;
}
function bindTime(pfx='f'){
  const el=document.getElementById(pfx+'-time');
  if(!el)return;
  el.oninput=()=>{
    const d=el.value.replace(/\D/g,'').slice(0,4);
    el.value = d.length<=2 ? d : d.slice(0,2)+':'+d.slice(2);
  };
}
function readTime(pfx='f'){
  const el=document.getElementById(pfx+'-time');
  if(!el)return '00:00';
  const raw=(el.value.trim()||el.placeholder||'00:00');
  const d=raw.replace(/\D/g,'').padEnd(4,'0').slice(0,4);
  const h=Math.min(23,+d.slice(0,2)), m=Math.min(59,+d.slice(2));
  return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0');
}

const close=()=>{scrim.classList.remove('open');sheet.classList.remove('open');editing=null};
scrim.onclick=close;

function shell(title,inner,del){
  body.innerHTML=`<div class="grab"></div><h2>${title}</h2>${inner}
    <div class="acts"><button class="btn ghost" id="cancelBtn">${del?'Видалити':'Скасувати'}</button>
    <button class="btn primary" id="saveBtn">Зберегти</button></div>`;
  const cancel=document.getElementById('cancelBtn');
  if(!del){ cancel.onclick=close; }
  else{
    /* Видалення в два дотики: окреме віконце вночі спросоння радше навчить
       тиснути «так» не читаючи, а от випадковий тап по «Видалити» — справжня
       втрата даних. Другий стан робимо гучним, щоб його не можна було не
       помітити, і не скидаємо за таймером: зникла кнопка бентежить більше,
       ніж лишається корисною. Передумали — закрийте форму. */
    let armed=false;
    cancel.onclick=()=>{
      if(armed){del();return}
      armed=true;
      cancel.textContent='Так, видалити';
      cancel.classList.add('arm');
      const hint=document.createElement('div');
      hint.className='del-hint';
      hint.textContent='Натисніть ще раз. Скасувати — закрити форму.';
      document.querySelector('.acts').after(hint);
    };
  }
  scrim.classList.add('open');sheet.classList.add('open');
}

/* У формі показуємо тільки активні призначення. Завершений курс зникає сам,
   бо в нього проставлена дата кінця. Секція згорнута, але позначене видно
   в заголовку — щоб нічого не записалось непомітно. */
const shiftDay=(iso,n)=>{const d=new Date(iso+'T00:00:00');d.setDate(d.getDate()+n);
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')};
const stamp2=m=>m.date+' '+(m.time||'00:00');
const lastQty=rid=>{
  const l=meds.filter(m=>m.rid===rid).sort((a,b)=>stamp2(a).localeCompare(stamp2(b)));
  return l.length?l[l.length-1].qty:regOf(rid).qty;
};

/* Доза, ліки й корм повторюються від уколу до уколу, а глюкоза — ні.
   Тому одна кнопка тягне весь минулий укол, крім показника. Саме останній
   укол, без поділу на ранок/вечір: дози змінюються за ситуацією. */
function lastShot(){
  const s=[...log].filter(e=>e.insulin!=null)
    .sort((a,b)=>stamp(a).localeCompare(stamp(b)));
  return s.length?s[s.length-1]:null;
}
function applyLastShot(){
  const e=lastShot();
  if(!e)return;
  document.getElementById('f-ins').value=e.insulin!=null?fmt(e.insulin):'';
  document.getElementById('f-food').value=e.food||'';
  const mine=meds.filter(m=>m.date===e.date&&(m.time||'')===(e.time||''));
  document.querySelectorAll('.mp-row').forEach(r=>{
    const own=mine.find(m=>m.rid===+r.dataset.rid);
    r.classList.toggle('on',!!own);
    if(own&&own.qty)r.querySelector('.mp-qty').value=own.qty;
  });
  const sum=document.querySelector('.mb-sum');
  if(sum){
    const names=[...document.querySelectorAll('.mp-row.on .mp-chip')].map(b=>b.textContent);
    sum.textContent=names.length?names.join(' · '):'нічого не позначено';
  }
}

/* Корм плаває: склад і грами міняються, тому даємо кілька недавніх варіантів
   одним тапом — правити рядок швидше, ніж набирати його щоразу. */
function lastFood(){
  const l=[...log].filter(e=>e.food&&e.insulin!=null)
    .sort((a,b)=>stamp(a).localeCompare(stamp(b)));
  return l.length?l[l.length-1].food:'';
}
function recentFoods(){
  const seen=[];
  [...log].filter(e=>e.food).sort((a,b)=>stamp(b).localeCompare(stamp(a)))
    .forEach(e=>{if(!seen.includes(e.food))seen.push(e.food)});
  return seen.slice(0,4);
}

function medPicker(e,id){
  const date=(id&&e.date)||TODAY;
  const act=activeRegimens(date);
  if(!act.length)return '<div class="hint">активних призначень немає</div>';
  const mine = id ? meds.filter(m=>m.date===e.date&&(m.time||'')===(e.time||'')) : [];
  const rows=act.map(r=>{
    const own=mine.find(m=>m.rid===r.id);
    /* Нічого не позначаємо самі: більшість записів — це просто заміри без
       ліків. Позначає або людина, або кнопка «як з минулим уколом». */
    const on = id ? !!own : false;
    return `<div class="mp-row${on?' on':''}" data-rid="${r.id}">
      <button type="button" class="mp-chip">${esc(r.name)}</button>
      <input class="mp-qty" value="${esc((own&&own.qty)||lastQty(r.id)||'')}" placeholder="кількість">
    </div>`;
  }).join('');
  const on=act.filter(r=>id&&mine.find(m=>m.rid===r.id));
  return `<details class="medbox"${on.length?' open':''}>
    <summary><span class="mb-label">Ліки</span>
      <span class="mb-sum">${on.length?on.map(r=>esc(r.name)).join(' · '):'нічого не позначено'}</span>
      <span class="mb-chev">${CHEV}</span></summary>
    <div class="medpick" id="f-meds">${rows}</div>
  </details>`;
}
function bindMedPicker(){
  const box=document.getElementById('f-meds');
  if(!box)return;
  const sum=document.querySelector('.mb-sum');
  const refresh=()=>{
    const names=[...document.querySelectorAll('.mp-row.on .mp-chip')].map(b=>b.textContent);
    if(sum)sum.textContent=names.length?names.join(' · '):'нічого не позначено';
    const box=document.querySelector('.medbox');
    if(box)box.classList.toggle('picked',!!names.length);
  };
  document.querySelectorAll('.mp-row').forEach(r=>{
    r.querySelector('.mp-chip').onclick=ev=>{ev.preventDefault();r.classList.toggle('on');refresh()};
  });
  refresh();
}
function saveMedPicker(date,time,prevKey){
  const box=document.getElementById('f-meds');
  if(!box)return;
  const key=date+' '+(time||'00:00');
  /* усе, що висіло на цьому моменті, знімаємо — і локально, і в таблиці */
  meds.filter(m=>stamp2(m)===key||(prevKey&&stamp2(m)===prevKey))
      .forEach(m=>API.remove('med',m.id));
  meds=meds.filter(m=>stamp2(m)!==key&&(!prevKey||stamp2(m)!==prevKey));
  box.querySelectorAll('.mp-row.on').forEach(r=>{
    const rid=+r.dataset.rid, qty=r.querySelector('.mp-qty').value.trim();
    const mid=API.uid('m');
    meds.push({id:mid,rid,date,time,qty});
    API.create('med',mid,{date,time,name:regOf(rid).name,qty,regimenId:rid});
  });
}

function openEntry(id){
  if(shotMode||!API.canWrite())return;
  const e=id?log.find(x=>x.id===id):{time:nowTime()};
  editing=id||null;
  shell(id?'Змінити запис':'Новий запис',`
    <div class="row2">
      <div class="field"><label for="f-date">Дата</label><input id="f-date" type="date" value="${e.date||TODAY}"></div>
      <div class="field"><label for="f-time">Час</label>${timeInput(nowTime(),'f',id?(e.time||''):'')}</div>
    </div>
    ${id||!lastShot()?'':`<div class="field">
      <button type="button" class="btn ghost fill" id="likeLast">Як з минулим уколом</button>
      <div class="hint">доза, ліки й корм з останнього уколу — глюкозу не чіпає</div></div>`}
    <div class="row2">
      <div class="field"><label for="f-glu">Глюкоза</label>
        <input id="f-glu" type="text" inputmode="decimal" placeholder="9,4 або Hi" value="${e.hi?'Hi':(e.glucose!=null?fmt(e.glucose):'')}"></div>
      <div class="field"><label for="f-ins">Доза, ОД</label>
        <input id="f-ins" type="text" inputmode="decimal" placeholder="0,5" value="${e.insulin!=null?fmt(e.insulin):''}">
        <div class="hint">0 = свідомо не зробили</div></div>
    </div>
    <div class="field"><label for="f-food">Корм</label>
      <input id="f-food" type="text" value="${id?esc(e.food):''}" placeholder="вологий 85 г">
      ${recentFoods().length?`<div class="foodchips">${recentFoods().map(f=>
        `<button type="button" class="fc" data-food="${esc(f)}">${esc(f)}</button>`).join('')}</div>`:''}</div>
    <div class="field">${medPicker(e,id)}</div>
    <div class="field"><label for="f-note">Моя нотатка</label><textarea id="f-note" placeholder="стан, поведінка">${esc(e.note)}</textarea></div>`,
    id?()=>{
      meds.filter(m=>m.date===e.date&&(m.time||'')===(e.time||''))
          .forEach(m=>API.remove('med',m.id));
      meds=meds.filter(m=>!(m.date===e.date&&(m.time||'')===(e.time||'')));
      API.remove('journal',id);
      log=log.filter(x=>x.id!==id);close();renderGlucose()}:null);
  bindTime('f');
  bindMedPicker();
  const ll=document.getElementById('likeLast');
  if(ll)ll.onclick=ev=>{ev.preventDefault();applyLastShot()};
  document.querySelectorAll('[data-food]').forEach(b=>b.onclick=ev=>{
    ev.preventDefault();document.getElementById('f-food').value=b.dataset.food});
  document.getElementById('saveBtn').onclick=()=>{
    const raw=document.getElementById('f-glu').value.trim().replace(',','.');
    const hi=/^hi$/i.test(raw);
    const ins=document.getElementById('f-ins').value.trim().replace(',','.');
    const data={date:document.getElementById('f-date').value||TODAY,
      time:readTime('f'),
      glucose:hi||!raw?null:parseFloat(raw),hi,
      insulin:ins===''?null:parseFloat(ins),
      food:document.getElementById('f-food').value.trim(),
      note:document.getElementById('f-note').value.trim(),
      vet:e.vet};
    const row={date:data.date,time:data.time,
      glucose:data.hi?'Hi':data.glucose,insulin:data.insulin,
      food:data.food,note:data.note};
    if(editing){Object.assign(log.find(x=>x.id===editing),data);API.update('journal',editing,row)}
    else{const nid=API.uid('j');log.push({id:nid,...data});API.create('journal',nid,row)}
    saveMedPicker(data.date,data.time,id?(e.date+' '+e.time):null);
    close();renderGlucose();
  };
}
let uMode='ml';
let stoolCat='нормальний';
function openUrine(id){
  if(shotMode||!API.canWrite())return;
  const u=id?urine.find(x=>x.id===id):{time:nowTime()};
  editing=id||null; if(id)uMode='ml';
  const draw=()=>{
    shell(id?'Змінити':'Новий запис',`
      ${id?'':`<div class="seg"><button data-m="ml" class="${uMode==='ml'?'on':''}">Сеча</button><button data-m="stool" class="${uMode==='stool'?'on':''}">Стул</button></div>`}
      ${uMode==='ml'?`<div class="row2">
        <div class="field"><label for="u-date">Дата</label><input id="u-date" type="date" value="${u.date||TODAY}"></div>
        <div class="field"><label for="u-time">Час</label>${timeInput(nowTime(),'u',id?(u.time||''):'')}</div></div>
        <div class="field"><label for="u-ml">Обʼєм, мл</label><input id="u-ml" type="text" inputmode="numeric" value="${u.ml||''}" placeholder="45"></div>`
      :`<div class="field"><label for="u-sdate">Дата</label>
          <input id="u-sdate" type="date" value="${TODAY}"></div>
        <div class="field"><label>Стул</label>
          <div class="seg wrap" id="u-scat">${STOOL.map(c=>
            `<button data-s="${c}" class="${c===stoolCat?'on':''}">${c}</button>`).join('')}</div></div>
        <div class="field"><label for="u-stool">Коментар</label>
          <textarea id="u-stool" placeholder="колір, кров, будь-що варте уваги"></textarea>
          <div class="hint">одна доба — один запис, без часу</div></div>`}`,
      id?()=>{API.remove('urine',id);urine=urine.filter(x=>x.id!==id);close();renderUrine()}:null);
    bindTime('u');
    body.querySelectorAll('[data-m]').forEach(b=>b.onclick=()=>{uMode=b.dataset.m;draw()});
    body.querySelectorAll('[data-s]').forEach(b=>b.onclick=()=>{stoolCat=b.dataset.s;draw()});
    document.getElementById('saveBtn').onclick=()=>{
      if(uMode==='ml'){
        const data={date:document.getElementById('u-date').value||TODAY,
          time:readTime('u'),
          ml:parseInt(document.getElementById('u-ml').value)||0};
        if(editing){Object.assign(urine.find(x=>x.id===editing),data);API.update('urine',editing,data)}
        else{const nid=API.uid('u');urine.push({id:nid,...data});API.create('urine',nid,data)}
      }else{
        const date=document.getElementById('u-sdate').value||TODAY;
        const text=document.getElementById('u-stool').value.trim();
        const found=stool.find(x=>x.date===date);
        const row={date,stool:stoolCat,note:text};
        if(found){Object.assign(found,{cat:stoolCat,text});API.update('day',found.id,row)}
        else{const nid=API.uid('d');stool.push({id:nid,date,cat:stoolCat,text});API.create('day',nid,row)}
      }
      close();renderUrine();
    };
  };
  draw();
}
document.getElementById('addBtn').onclick=()=>{
  if(view==='urine')openUrine(); else openEntry();
};
function applyShot(){
  document.body.classList.toggle('shot',shotMode);
}

/* «Ще» — шухляда для рідкого: ліки, посилання на таблицю, службове.
   Ліки сюди переїхали свідомо: вони вписуються через форму запису і видні
   в нотатках, тож постійне місце в барі їм не потрібне. */
let moreMode=null;

function renderMore(){
  if(moreMode==='meds')return renderMeds();
  beginRender();
  document.getElementById('side').innerHTML='';
  document.getElementById('main').innerHTML=`
    <div class="more-list">
      <button class="more-item" data-more="meds">Ліки
        <span class="mi-sub">курси і прийоми</span></button>
      ${sheetUrl?`<a class="more-item" href="${sheetUrl}" target="_blank"
        rel="noopener">Таблиця<span class="mi-sub">переглянути</span></a>`:''}
      ${notionUrl?`<a class="more-item" href="${notionUrl}" target="_blank"
        rel="noopener">Хронологія<span class="mi-sub">аналізи, історія хвороби</span></a>`:''}
    </div>
    <div class="more-note">Збірка v${BUILD}${API.env()==='dev'?' · DEV':''}<br>
      Дані станом на ${hhmmOf(new Date(API.cachedAt()))}.<br>
      ${loadedFrom?`Завантажено з ${dateShort(loadedFrom)}${
        allLoaded?' — це вся історія':', є старіші'}.`:''}</div>`;
  document.querySelector('[data-more="meds"]').onclick=()=>{
    moreMode='meds';needScroll=true;renderMore();
  };
  afterRender();
}

const views={glucose:renderGlucose,cycles:renderCycles,urine:renderUrine,more:renderMore};
function setView(v){
  document.body.classList.remove('hh');
  /* Захід у розділ ставить сторінку на найсвіжіші записи — там, куди веде
     сортування. Пам'яті позиції тут більше немає: у списку, що читається
     згори вниз, «де я був минулого разу» майже завжди означало «на найстаріших
     записах», бо саме туди відкривався розділ уперше.
     Прапорець ставимо до малювання: його читає afterRender() всередині. */
  const sameView=(v===view);
  if(!sameView)needScroll=true;
  view=v;views[v]();updateJump();
  /* «＋» знає, де ти стоїш: у журналі це замір, у сечі — лоток або стул.
     Зайвого питання «що записуємо» не потрібно. */
  document.getElementById('addBtn').classList.toggle('hidden',
    shotMode||!API.canWrite());
  document.querySelectorAll('.tabbar [data-view]').forEach(b=>
    b.setAttribute('aria-selected', String(b.dataset.view===v)));
  updateNow();
}
document.querySelectorAll('.tabbar [data-view]').forEach(t=>
  t.onclick=()=>{ if(t.dataset.view==='more')moreMode=null; setView(t.dataset.view); });

/* Поточний показник у шапці — той самий у будь-якому розділі. */
function updateNow(){
  const el=document.getElementById('now');
  if(!el||!log.length)return;
  const top=[...log].sort((a,b)=>stamp(b).localeCompare(stamp(a)))[0];
  el.innerHTML=`${top.time} · <b>${top.hi?'Hi':top.glucose!=null?fmt(top.glucose):'—'}</b>`;
}

/* Ховаємо шапку тільки коли справді гортаємо вниз і вже відійшли від верху,
   щоб вона не сіпалась від інерції на дрібних рухах. */
(function(){
  let last=0, ticking=false;
  /* Програмна прокрутка (стрибок до найсвіжіших, зміна порядку) виглядає для
     цього обробника як різкий рух пальцем униз, і він ховає шапку. Тому після
     кожного такого стрибка перезадаємо точку відліку. */
  window.rebaseHeader=()=>{
    last=Math.max(0,window.scrollY);
    document.body.classList.remove('hh');
  };
  const apply=()=>{
    const y=Math.max(0,window.scrollY);
    const dy=y-last;
    if(y<80) document.body.classList.remove('hh');
    else if(dy>6) document.body.classList.add('hh');
    else if(dy<-6) document.body.classList.remove('hh');
    last=y; ticking=false;
    updateJump();
  };
  window.addEventListener('scroll',()=>{
    if(!ticking){ticking=true;requestAnimationFrame(apply)}
  },{passive:true});
})();

/* ────────────────────────────── старт ────────────────────────────── */

const banner=document.getElementById('banner');
function say(text,kind){
  if(!banner)return;
  banner.textContent=text||'';
  banner.className='banner'+(kind?' '+kind:'');
  banner.hidden=!text;
}

function screen(html){document.getElementById('main').innerHTML=html;
  document.getElementById('side').innerHTML=''}

/**
 * Відхилений сервером запис — єдиний випадок, коли екран бреше: рядок на
 * ньому є, а в таблиці його немає. Тому банер тут не зникає сам і веде до
 * розбору: або повторити, або привести екран до таблиці.
 */
function failBanner(){
  const n=API.failed().length;
  if(!n)return false;
  say(`Не збереглося в таблицю: ${n} ${plural(n,'запис','записи','записів')} — торкніться`,'err');
  return true;
}

function openFailed(){
  const list=API.failed();
  if(!list.length)return;
  const rows=list.map(f=>{
    const d=f.op.data||{};
    const what={journal:'запис',urine:'лоток',day:'стул',med:'ліки',regimen:'курс'}[f.op.sheet]||f.op.sheet;
    const act={create:'додати',update:'змінити',delete:'видалити'}[f.op.action]||f.op.action;
    return `<div class="mrow"><span class="md">${esc(d.date||'')}</span>
      <span class="mq">${act} ${what}</span>
      <span class="mn">${esc(f.error||'')}</span></div>`;
  }).join('');
  shell('Не потрапило в таблицю',
    `<div class="hint">Ці зміни видно на екрані, але в таблиці їх немає.
      Спробуйте ще раз — або приберіть, і екран перечитається з таблиці.</div>
     <div class="mlist">${rows}</div>`);
  document.getElementById('saveBtn').textContent='Спробувати ще';
  document.getElementById('saveBtn').onclick=()=>{API.retryFailed();close();say('')};
  document.getElementById('cancelBtn').textContent='Прибрати';
  document.getElementById('cancelBtn').onclick=async()=>{
    API.dropFailed();close();
    try{ show(await API.load(daysWanted)); say(''); }
    catch(err){ say('Не вдалося перечитати: '+esc(String(err.message||err)),'err'); }
  };
}

API.on((kind,detail)=>{
  if(kind==='failed'&&detail.count===0){say('');return}
  if(kind==='failed'){failBanner();return}
  if(kind==='queue'&&!failBanner())
    say(detail.pending?'Не відправлено записів: '+detail.pending:'', 'wait');
});

if(banner)banner.onclick=()=>{ if(API.failed().length)openFailed(); };

const hhmmOf=d=>String(d.getHours()).padStart(2,'0')+':'+
  String(d.getMinutes()).padStart(2,'0');

let paints=0;

function show(data){
  adopt(data);
  markAllLoaded(data);
  document.body.classList.toggle('ro',!API.canWrite());
  /* Малювань при старті два: із кешу і зі свіжих даних за кілька секунд.
     Обидва стають на найсвіжіші — інакше друге лишало б там, куди приїхало
     перше, а даних за цей час могло прибавитись. Далі вже нікуди не тягнемо. */
  if(paints<2){ needScroll=true; paints++; }
  setView(view);
}

/* Apps Script відповідає 3–7 секунд, і тримати цей час порожній екран не можна.
   Тому спершу малюємо збережене з минулого разу, а свіже застосовуємо, щойно
   прийде. Перший в житті запуск — єдиний, коли доводиться чекати. */
/**
 * Пауза в записах не має виглядати як порожній застосунок. Вікно рахується
 * від сьогодні, тому після кількох тижнів без відміток — ремісія, від'їзд,
 * будь-що — у нього просто нічого не потрапляє, хоч уся історія на місці.
 * Тоді розширюємо вікно самі, доки щось не знайдеться.
 */
async function widenIfEmpty(){
  let tries=0;
  while(!log.length&&!allLoaded&&tries<3){
    tries++;
    daysWanted*=3;
    const data=await API.load(daysWanted);
    adopt(data);markAllLoaded(data);
  }
  if(tries)show(API.offline()||{journal:log});
  return tries;
}

async function boot(){
  const badge=document.getElementById('env');
  if(badge){
    badge.textContent=(API.env()==='dev'?'DEV ':'')+'v'+BUILD;
    badge.hidden=false;
  }

  const cached=API.offline();
  if(cached){
    show(cached);
    /* Кажемо прямо, що на екрані збережене і якої воно давнини: інакше можна
       прочитати вчорашній показник як сьогоднішній. */
    say('дані станом на '+hhmmOf(new Date(API.cachedAt()))+', оновлюю…','wait');
  }
  else screen('<div class="empty">Завантаження…</div>');

  try{
    show(await API.load());
    if(!log.length)await widenIfEmpty();
    if(!failBanner())say(API.pending()?'Не відправлено записів: '+API.pending():'');
  }catch(err){
    if(!cached){
      screen('<div class="empty">Не вдалося завантажити дані.<br><br>'+
        esc(String(err.message||err))+'</div>');
      return;
    }
    say('Немає зв\'язку. Показано збережене від '+hhmmOf(new Date(API.cachedAt())),'wait');
  }
  API.flush();
}

boot();
