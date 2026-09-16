// 绳结成型与滑移验收 —— 页面（静态 HTML + 调 API，判定一律以后端 evaluate 为准）
export function renderPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>绳结成型与滑移验收</title>
<style>
  :root { --bg:#eef1ea; --panel:#fff; --ink:#20241f; --muted:#687366; --line:#d4ddd0;
          --accent:#4c6b3d; --safe:#3d7a4d; --warn:#a8741c; --danger:#9b3527; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC","Microsoft YaHei",sans-serif; }
  header { padding:20px 26px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:12px; }
  h1 { margin:0; font-size:23px; } h2 { margin:0 0 10px; font-size:16px; } h3 { margin:0; font-size:16px; }
  main { display:grid; grid-template-columns:370px 1fr; gap:18px; padding:18px 26px; align-items:start; }
  form, .panel, .card { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px; }
  form { margin-bottom:14px; }
  label { display:block; margin:8px 0 3px; color:var(--muted); font-size:12px; }
  input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; background:#fff; }
  .row2 { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
  button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:9px 12px; font-weight:700; cursor:pointer; margin-top:12px; }
  button.ghost { background:#69736a; }
  button.danger { background:var(--danger); }
  button:disabled { opacity:.45; cursor:not-allowed; }
  .hint { font-size:12px; color:var(--muted); margin-top:6px; }
  .hint b { color:var(--ink); }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:10px; margin-bottom:14px; }
  .stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:12px; }
  .stat strong { display:block; font-size:24px; }
  .stat.safe strong { color:var(--safe); } .stat.warn strong { color:var(--warn); } .stat.danger strong { color:var(--danger); }
  .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:12px; align-items:center; }
  .toolbar input,.toolbar select { width:auto; min-width:150px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(330px,1fr)); gap:12px; }
  .card.danger { border-color:var(--danger); border-width:2px; }
  .card.warn { border-color:var(--warn); border-width:2px; }
  .pill { display:inline-block; border-radius:999px; padding:2px 9px; font-size:12px; color:#fff; }
  .pill.safe { background:var(--safe); } .pill.warn { background:var(--warn); } .pill.danger { background:var(--danger); } .pill.pending { background:#69736a; }
  .meta { color:var(--muted); font-size:12px; }
  .kv { display:grid; grid-template-columns:auto 1fr; gap:2px 10px; font-size:13px; margin:8px 0; }
  .progress { height:8px; background:#e4e8e0; border-radius:999px; overflow:hidden; margin:6px 0; }
  .progress > i { display:block; height:100%; background:var(--accent); }
  .reasons { margin:6px 0 0; padding-left:18px; font-size:12px; }
  .reasons .r-danger { color:var(--danger); font-weight:700; }
  .reasons .r-rework { color:var(--warn); font-weight:700; }
  .sealed { margin-top:8px; padding:7px 9px; border-radius:6px; background:#f0ece2; font-size:12px; font-weight:700; }
  .sealed.safe { background:#e3f0e5; color:var(--safe); } .sealed.reject { background:#f7e4e0; color:var(--danger); } .sealed.rework { background:#f8efdd; color:var(--warn); }
  .dangerlist { border:1px solid var(--danger); }
  .dangerlist .item { padding:7px 0; border-top:1px solid var(--line); font-size:13px; cursor:pointer; }
  .dangerlist .item:first-of-type { border-top:0; }
  #toast { position:fixed; right:18px; bottom:18px; max-width:380px; display:none; background:var(--danger); color:#fff; padding:12px 14px; border-radius:8px; font-size:13px; white-space:pre-wrap; z-index:9; }
  .batchrow { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  svg { display:block; }
  @media (max-width:960px){ main{grid-template-columns:1fr;} header{padding:16px;} }
</style>
</head>
<body>
<header>
  <div><h1>绳结成型与滑移验收</h1>
  <div class="meta">每根索登记绳径 / 结型 / 绕圈数 / 尾长 / 预紧力 / 额定载荷；≥5 次加载循环逐次记录尾端滑移；一次确认只生成一个不可覆盖结果。</div></div>
  <button class="ghost" id="reload">刷新数据</button>
</header>
<main>
  <section>
    <form id="registerForm">
      <h2>① 成型登记（成型员）</h2>
      <div class="row2">
        <div><label>索号 *</label><input name="ropeNo" required placeholder="如 R-2026-018"></div>
        <div><label>使用部位 *</label><input name="location" required placeholder="如 前桅侧支索"></div>
      </div>
      <div class="row2">
        <div><label>绳径 d (mm) *</label><input name="diameterMm" type="number" step="0.1" min="0.1" required id="diameterInput"></div>
        <div><label>结型 *</label><select name="knotType" id="knotSelect" required></select></div>
      </div>
      <div class="row2">
        <div><label>绕圈数 *</label><input name="turns" type="number" step="1" min="1" required id="turnsInput"></div>
        <div><label>尾长 (mm) *</label><input name="tailLengthMm" type="number" step="0.1" min="0" required></div>
      </div>
      <div class="row2">
        <div><label>预紧力 (N) *</label><input name="preloadN" type="number" step="any" min="0" required></div>
        <div><label>额定载荷 (N) *</label><input name="ratedLoadN" type="number" step="any" min="0" required></div>
      </div>
      <div class="row2">
        <div><label>成型员 *</label><input name="formerName" required></div>
        <div><label>验收员（不可与成型员同人）*</label><input name="inspectorName" required></div>
      </div>
      <label>备注</label><textarea name="note"></textarea>
      <div class="hint" id="knotHint"></div>
      <button>登记绳索</button>
    </form>

    <form id="cycleForm">
      <h2>② 加载循环记录</h2>
      <label>选择绳索（仅未确认）</label><select name="ropeId" id="cycleRope"></select>
      <div class="hint" id="cycleSeqHint"></div>
      <div class="row2">
        <div><label>本次载荷 (N) *</label><input name="loadN" type="number" step="any" min="0" required></div>
        <div><label>尾端累计滑移 (mm) *</label><input name="tailSlipMm" type="number" step="0.01" min="0" required></div>
      </div>
      <div class="hint">序号由服务端递增分配，重复或跳号将被拒绝；累计滑移必须单调不减。</div>
      <button>提交循环</button>
    </form>

    <form id="confirmForm">
      <h2>③ 验收确认（验收员，职责分离）</h2>
      <label>选择绳索</label><select name="ropeId" id="confirmRope"></select>
      <label>验收员签名（须与登记验收员一致）</label><input name="inspectorName" required>
      <div class="batchrow">
        <button id="singleConfirmBtn">单根确认（结果不可覆盖）</button>
      </div>
      <div class="hint">批量确认：整批任一不满足则全部回滚，不留半批记录。</div>
      <div class="batchrow">
        <input type="hidden" id="batchIds">
        <button type="button" class="ghost" id="batchPickBtn">勾选待验收索…</button>
        <span class="hint" id="batchInfo"></span>
      </div>
      <button type="button" class="danger" id="batchConfirmBtn" disabled>批量确认（0）</button>
    </form>
  </section>

  <section>
    <div class="stats" id="stats"></div>
    <div class="panel dangerlist" id="dangerPanel" style="margin-bottom:14px"><h2>危险项（拒绝 / 滑移未稳定 / 余量不足）</h2><div id="dangerItems"><div class="meta">暂无</div></div></div>
    <div class="toolbar">
      <select id="verdictFilter"><option value="">全部判定</option><option value="safe">安全通过</option><option value="rework">返工</option><option value="reject">拒绝</option><option value="pending">待确认</option></select>
      <input id="search" placeholder="搜索索号 / 部位 / 人员">
      <button class="ghost" type="button" id="exportBtn" style="margin-top:0">导出判定 JSON</button>
    </div>
    <div class="grid" id="cards"></div>
  </section>
</main>
<div id="toast"></div>

<script>
"use strict";
var MIN_CYCLES = 5;
var knots = {}, limits = {}, ropes = [], batchSet = {};
function $(s){ return document.querySelector(s); }
function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];});}
function api(path, opts){
  return fetch(path, opts && opts.body ? Object.assign({},opts,{headers:Object.assign({"Content-Type":"application/json"},opts.headers||{})}) : opts)
    .then(function(r){ return r.json().then(function(d){ if(!r.ok){ var e=new Error((d.details||[d.error||"请求失败"]).join("\\n")); e.body=d; throw e; } return d; }); });
}
function toast(msg){ var t=$("#toast"); t.textContent=msg; t.style.display="block"; clearTimeout(toast._t); toast._t=setTimeout(function(){ t.style.display="none"; },6000); }
function num(v){ return Number(v); }

function loadKnots(){
  return api("/api/knots").then(function(d){ knots=d.knots; limits=d.limits; MIN_CYCLES=d.minCycles; renderKnotOptions(); updateHint(); });
}
function loadRopes(){
  return api("/api/ropes").then(function(d){ ropes=d; render(); });
}
function renderKnotOptions(){
  $("#knotSelect").innerHTML = Object.keys(knots).map(function(k){
    var x=knots[k]; return "<option value='"+k+"'>"+esc(x.name)+"（效率 "+(x.efficiency*100)+"%）</option>";
  }).join("");
}
function updateHint(){
  var k=knots[$("#knotSelect").value], d=num($("#diameterInput").value);
  if(!k) return;
  var minTail = d>0 ? Math.max(k.minTailD*d,50) : null;
  var maxSlip = d>0 ? d : null;
  $("#knotHint").innerHTML = "结型效率 <b>"+(k.efficiency*100)+"%</b>，要求至少 <b>"+k.minTurns+"</b> 圈" +
    (minTail? "，最小尾长 <b>"+minTail.toFixed(1)+" mm</b>" : "") +
    (maxSlip? "，最大允许滑移 <b>"+maxSlip.toFixed(2)+" mm</b>（1d，末次增量≤"+(0.15*d).toFixed(2)+"mm），安全载荷余量≥"+limits.marginSafe : "");
}

function unconfirmed(){ return ropes.filter(function(r){ return !r.confirmation; }); }
function verdictOf(r){ return r.confirmation ? r.confirmation.verdict : r.evaluation.verdict; }

function render(){
  var counts={safe:0,rework:0,reject:0,pending:0};
  ropes.forEach(function(r){ if(r.confirmation) counts[r.confirmation.verdict]++; else counts.pending++; });
  $("#stats").innerHTML =
    stat("safe","安全通过",counts.safe)+stat("warn","返工",counts.rework)+stat("danger","拒绝",counts.reject)+stat("","待确认",counts.pending);

  // 危险项
  var dangers=[];
  ropes.forEach(function(r){
    var ev=r.confirmation||r.evaluation;
    var bad=(ev.reasons||[]).filter(function(x){return x.level==="reject";});
    if(ev.verdict==="reject" && bad.length) dangers.push({r:r, bad:bad, sealed:!!r.confirmation});
  });
  $("#dangerItems").innerHTML = dangers.length ? dangers.map(function(x){
    return "<div class='item' data-no='"+esc(x.r.ropeNo)+"'><b>"+esc(x.r.ropeNo)+"</b> "+esc(x.r.location||"")+
      (x.sealed?" <span class='pill danger'>已拒绝</span>":"")+"<br><span class='r-danger'>"+esc(x.bad.map(function(b){return b.message;}).join("；"))+"</span></div>";
  }).join("") : "<div class='meta'>暂无</div>";
  $("#dangerItems").querySelectorAll(".item").forEach(function(el){
    el.onclick=function(){ location.hash=""; location.hash="rope-"+encodeURIComponent(el.dataset.no); };
  });

  // 下拉
  var uc=unconfirmed();
  $("#cycleRope").innerHTML = uc.length ? uc.map(function(r){return "<option value='"+r.id+"'>"+esc(r.ropeNo)+" · "+esc(r.location||"")+"（循环 "+r.cycles.length+" 次）</option>";}).join("") : "<option value=''>（暂无未确认绳索）</option>";
  $("#confirmRope").innerHTML = uc.length ? uc.map(function(r){return "<option value='"+r.id+"'>"+esc(r.ropeNo)+" · "+esc(r.location||"")+"</option>";}).join("") : "<option value=''>（暂无未确认绳索）</option>";
  updateCycleHint();

  // 卡片
  var f=$("#verdictFilter").value, q=$("#search").value.trim();
  var vis=ropes.filter(function(r){
    var v=r.confirmation?r.confirmation.verdict:"pending";
    if(f && v!==f) return false;
    if(q && JSON.stringify({no:r.ropeNo,location:r.location,former:r.formerName,inspector:r.inspectorName}).indexOf(q)<0) return false;
    return true;
  });
  $("#cards").innerHTML = vis.map(cardHtml).join("") || "<div class='meta'>没有符合条件的绳索</div>";
}
function stat(cls,label,n){ return "<div class='stat "+cls+"'><span>"+label+"</span><strong>"+n+"</strong></div>"; }

function sparkline(r, ev){
  var cs=r.cycles; if(!cs.length) return "<div class='meta'>尚无循环记录</div>";
  var W=300,H=90,pad=26;
  var xs=cs.map(function(c){return c.seq;});
  var maxX=Math.max(MIN_CYCLES, Math.max.apply(null,xs));
  var maxY=Math.max(ev.metrics.maxAllowedSlipMm*1.15, Math.max.apply(null,cs.map(function(c){return c.tailSlipMm;}))*1.15, 0.01);
  function X(i){ return pad+(i-1)/(Math.max(maxX-1,1))*(W-pad-6); }
  function Y(v){ return H-18-(v/maxY)*(H-30); }
  var pts=cs.map(function(c,i){ return X(c.seq).toFixed(1)+","+Y(c.tailSlipMm).toFixed(1); }).join(" ");
  var limY=Y(ev.metrics.maxAllowedSlipMm);
  var marks="";
  for(var n=1;n<=maxX;n++){ marks+="<line x1='"+X(n)+"' y1='"+(H-18)+"' x2='"+X(n)+"' y2='"+(H-14)+"' stroke='#9aa394'/><text x='"+(X(n)-3)+"' y='"+(H-3)+"' font-size='9' fill='#687066'>"+n+"</text>"; }
  var dots=cs.map(function(c,i){ var bad=c.seq>=MIN_CYCLES?false:false; return "<circle cx='"+X(c.seq)+"' cy='"+Y(c.tailSlipMm)+"' r='3' fill='#4c6b3d'/>"; }).join("");
  return "<svg width='100%' viewBox='0 0 "+W+" "+H+"'>" +
    "<line x1='"+pad+"' y1='"+limY+"' x2='"+(W-6)+"' y2='"+limY+"' stroke='#9b3527' stroke-dasharray='4 3'/>" +
    "<text x='"+(W-90)+"' y='"+(limY-3)+"' font-size='9' fill='#9b3527'>允许滑移上限 "+ev.metrics.maxAllowedSlipMm+"mm</text>" +
    "<polyline fill='none' stroke='#4c6b3d' stroke-width='2' points='"+pts+"'/>"+dots+marks+
    "<text x='2' y='12' font-size='9' fill='#687366'>累计滑移 mm / 循环序号</text></svg>";
}

function cardHtml(r){
  var ev=r.confirmation||r.evaluation, v=ev.verdict, cls=r.confirmation ? "" : (v==="reject"?"danger":v==="rework"?"warn":"");
  var pill = r.confirmation ? "<span class='pill "+(v==="safe"?"safe":v==="rework"?"warn":"danger")+"'>"+esc(ev.verdictLabel)+"（已定案）</span>"
                             : "<span class='pill "+(v==="safe"?"safe":v==="rework"?"warn":v==="reject"?"danger":"pending")+"'>"+esc(ev.verdictLabel)+"</span>";
  var m=ev.metrics;
  var prog=Math.min(m.cycleCount,MIN_CYCLES);
  var incr=(m.slipIncrements||[]).map(function(x,i){return (i===0?"#"+(i+1)+" "+x.toFixed(2):"Δ"+x.toFixed(2));}).join("  ");
  var reasons=(ev.reasons||[]).length ? "<ul class='reasons'>"+ev.reasons.map(function(x){
      return "<li class='r-"+x.level+"'>"+(x.level==="reject"?"【拒绝】":"【返工】")+esc(x.message)+"</li>";
    }).join("")+"</ul>" : "<div class='hint' style='color:var(--safe)'>全部指标合格</div>";
  var sealed = r.confirmation ? "<div class='sealed "+v+"'>🔒 不可覆盖结果 · 验收员 "+esc(ev.inspectorName)+" · 成型员 "+esc(ev.formerName)+" · "+esc(ev.at)+"</div>"
             : "<div class='hint'>待验收员确认；确认后冻结，不可覆盖。</div>";
  var checked = batchSet[r.id] ? "checked" : "";
  return "<article class='card "+cls+"' id='rope-"+encodeURIComponent(r.ropeNo)+"'>" +
    "<div style='display:flex;justify-content:space-between;align-items:center;gap:6px'><h3>"+esc(r.ropeNo)+"</h3>"+
      (r.confirmation?"":("<label style='margin:0'><input type='checkbox' data-batch='"+r.id+"' "+checked+" style='width:auto'> 批量</label>"))+"</div>" +
    "<div class='meta'>"+esc(r.location||"")+"</div><div>"+pill+"</div>" +
    "<div class='progress' title='循环进度'><i style='width:"+(prog/MIN_CYCLES*100)+"%'></i></div>" +
    "<div class='meta'>循环进度 "+m.cycleCount+" / "+MIN_CYCLES+"</div>" +
    sparkline(r,ev)+(incr?"<div class='meta'>滑移序列(mm)："+esc(incr)+"</div>":"")+
    "<div class='kv'>" +
      kv("绳径 d", r.diameterMm+" mm")+kv("结型", esc(m.knotName))+
      kv("绕圈数", r.turns+"（"+(knots[r.knotType]?knots[r.knotType].minTurns:0)+"）")+
      kv("尾长", r.tailLengthMm+" mm（"+(m.tailRatio!=null?m.tailRatio+"d":"-")+"，最小 "+(m.minTailLengthMm??"-")+" mm）")+
      kv("预紧/额定", r.preloadN+" / "+r.ratedLoadN+" N")+
      kv("累计滑移", (m.totalSlipMm??0)+" / 允许 "+(m.maxAllowedSlipMm??"-")+" mm")+
      kv("末次增量", (m.lastIncrementMm??0).toFixed(2)+" mm（≤"+(0.15*r.diameterMm).toFixed(2)+"）")+
      kv("载荷余量", m.loadMargin==null?"-":m.loadMargin.toFixed(2)+"（安全 ≥"+limits.marginSafe+"）")+
      kv("滑移稳定", m.slipStable?"是":"否")+
      kv("成型 / 验收", esc(r.formerName)+" / "+esc(r.inspectorName))+
    "</div>" + reasons + sealed +
  "</article>";
}
function kv(k,v){ return "<span class='meta'>"+k+"</span><span>"+v+"</span>"; }

function updateCycleHint(){
  var id=$("#cycleRope").value, r=ropes.find(function(x){return x.id===id;});
  if(!r){ $("#cycleSeqHint").textContent=""; return; }
  $("#cycleSeqHint").innerHTML="下一次序号 <b>"+(r.cycles.length+1)+"</b>（已录 "+r.cycles.length+" 次，至少 "+MIN_CYCLES+" 次）";
}

// 表单数值字段必须转成真正的 number 再提交（严格后端不接受字符串/布尔）。
// num：有限数；int：正整数。返回 { value, errors }。
function typedFormData(form, numFields, intFields){
  var o=Object.fromEntries(new FormData(form).entries());
  var errors=[];
  (numFields||[]).forEach(function(k){
    var raw=o[k];
    if(raw==="" || raw===undefined){ errors.push("请填写 "+k); return; }
    var n=Number(raw);
    if(!isFinite(n)){ errors.push(k+" 必须是数字"); return; }
    o[k]=n;
  });
  (intFields||[]).forEach(function(k){
    var raw=o[k];
    if(raw==="" || raw===undefined){ errors.push("请填写 "+k); return; }
    var n=Number(raw);
    if(!Number.isInteger(n)){ errors.push(k+" 必须是整数"); return; }
    o[k]=n;
  });
  return { value:o, errors:errors };
}

$("#registerForm").onsubmit=function(e){
  e.preventDefault();
  var f=e.target;
  var t=typedFormData(f,["diameterMm","tailLengthMm","preloadN","ratedLoadN"],["turns"]);
  if(t.errors.length){ toast(t.errors.join("\\n")); return; }
  api("/api/ropes",{method:"POST",body:JSON.stringify(t.value)}).then(function(){ f.reset(); updateHint(); return loadRopes(); })
    .then(function(){ toast("已登记，等待加载循环"); }).catch(function(err){ toast(err.message); });
};
$("#cycleForm").onsubmit=function(e){
  e.preventDefault();
  var id=$("#cycleRope").value;
  var r=ropes.find(function(x){return x.id===id;});
  if(!r){ toast("请选择未确认绳索"); return; }
  var t=typedFormData(e.target,["loadN","tailSlipMm"],[]);
  if(t.errors.length){ toast(t.errors.join("\\n")); return; }
  delete t.value.ropeId; // ropeId 在 URL 中，循环载荷只接受 expectedSeq/loadN/tailSlipMm
  t.value.expectedSeq=r.cycles.length+1; // 真正的整数序号
  api("/api/ropes/"+encodeURIComponent(id)+"/cycles",{method:"POST",body:JSON.stringify(t.value)})
    .then(function(){ e.target.reset(); updateCycleHint(); return loadRopes(); }).catch(function(err){ toast(err.message); });
};
$("#confirmForm").onsubmit=function(e){
  e.preventDefault();
  var fd=Object.fromEntries(new FormData(e.target).entries());
  api("/api/ropes/"+encodeURIComponent(fd.ropeId)+"/confirm",{method:"POST",body:JSON.stringify({inspectorName:fd.inspectorName})})
    .then(function(d){ return loadRopes().then(function(){ toast("已定案："+d.confirmation.verdictLabel); }); }).catch(function(err){ toast(err.message); });
};
$("#cycleRope").onchange=updateCycleHint;
$("#knotSelect").onchange=updateHint;
$("#diameterInput").oninput=updateHint;
$("#verdictFilter").onchange=render;
$("#search").oninput=render;
$("#reload").onclick=function(){ loadRopes().then(function(){toast("已刷新");}); };

$("#batchPickBtn").onclick=function(){ toast("在卡片右上角勾选「批量」复选框选择待验收索。"); };
$("#exportBtn").onclick=function(){
  var blob=new Blob([JSON.stringify(ropes.map(function(r){return r.confirmation||r.evaluation;}),null,2)],{type:"application/json"});
  var a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download="knot-evaluation.json"; a.click();
};
document.addEventListener("change",function(e){
  var id=e.target.getAttribute && e.target.getAttribute("data-batch");
  if(!id) return;
  if(e.target.checked) batchSet[id]=1; else delete batchSet[id];
  var ids=Object.keys(batchSet);
  $("#batchConfirmBtn").textContent="批量确认（"+ids.length+"）";
  $("#batchConfirmBtn").disabled=ids.length===0;
  $("#batchInfo").textContent=ids.length?("已选 "+ids.length+" 根"):"";
});
$("#batchConfirmBtn").onclick=function(){
  var ids=Object.keys(batchSet);
  var name=$("#confirmForm").inspectorName.value.trim();
  if(!name){ toast("请先在上方填写验收员签名"); return; }
  api("/api/ropes/batch-confirm",{method:"POST",body:JSON.stringify({ids:ids,inspectorName:name})})
    .then(function(d){
      batchSet={}; $("#batchConfirmBtn").disabled=true; $("#batchConfirmBtn").textContent="批量确认（0）"; $("#batchInfo").textContent="";
      return loadRopes().then(function(){ toast("批量定案 "+d.confirmed+" 根"); });
    }).catch(function(err){
      if(err.body && err.body.problems){
        toast("整批已回滚，未定案任何绳索：\\n"+err.body.problems.map(function(p){return p.id+" → "+p.error;}).join("\\n"));
      } else toast(err.message);
      loadRopes();
    });
};

loadKnots().then(loadRopes).catch(function(e){ toast(e.message); });
setInterval(loadRopes, 15000); // 多人作业时自动看到进度
</script>
</body>
</html>`;
}
