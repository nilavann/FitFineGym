(function(){
"use strict";
var $=function(s,r){return (r||document).querySelector(s)},$$=function(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s))};
var reduce=matchMedia("(prefers-reduced-motion: reduce)");
var clamp=function(v,a,b){return Math.max(a===undefined?0:a,Math.min(b===undefined?1:b,v))};
var ARROW='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17L17 7M8 7h9v9"/></svg>';
var lang="en";try{lang=localStorage.getItem("fnf-lang")||"en"}catch(e){}
function tr(en,ta){return lang==="ta"?ta:en}

/* ---------- generated illustrations: Silambam and Kuthu Fit ---------- */
function svgURI(s){return "data:image/svg+xml;charset=utf-8,"+encodeURIComponent(s)}
function limb(pts,w){return '<polyline points="'+pts+'" fill="none" stroke="#120a06" stroke-width="'+w+'" stroke-linecap="round" stroke-linejoin="round"/>'}
function illo(kind){
  var g=kind==="silambam"?["#2a0d05","#c4461a","#ffb347"]:["#2b0a3a","#d6336c","#ffb347"],s='';
  s+='<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="'+g[0]+'"/><stop offset=".6" stop-color="'+g[1]+'"/><stop offset="1" stop-color="'+g[2]+'"/></linearGradient><radialGradient id="s" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#ffe9b0"/><stop offset="1" stop-color="#ffe9b0" stop-opacity="0"/></radialGradient></defs><rect width="800" height="1000" fill="url(#g)"/><circle cx="540" cy="360" r="320" fill="url(#s)" opacity=".7"/><circle cx="540" cy="360" r="150" fill="#ffe9b0" opacity=".9"/>';
  if(kind==="silambam"){
    s+=limb("130,600 720,150",14)+limb("410,560 560,700 580,880",50)+limb("410,560 260,720 190,880",50)+limb("420,370 410,560",64)+limb("420,380 520,330 600,236",34)+limb("420,390 340,440 262,500",34)+'<circle cx="424" cy="300" r="46" fill="#120a06"/>';
  }else{
    s+=limb("400,350 400,530",64)+limb("400,370 310,280 262,160",34)+limb("400,370 500,270 570,180",34)+limb("400,530 330,700 318,880",48)+limb("400,530 520,620 610,700",48)+'<circle cx="400" cy="270" r="46" fill="#120a06"/>';
    for(var i=0;i<14;i++){s+='<circle cx="'+(60+i*55)+'" cy="'+(80+(i*137%500))+'" r="'+(6+i%4*3)+'" fill="#ffe9b0" opacity=".5"/>'}
  }
  s+='<rect y="880" width="800" height="120" fill="#120a06" opacity=".92"/>';
  return svgURI('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000" viewBox="0 0 800 1000" preserveAspectRatio="xMidYMid slice">'+s+'</svg>');
}
MEDIA.img.silambam=illo("silambam");MEDIA.img.kuthu=illo("kuthu");

/* ---------- language ---------- */
$$("[data-ta]").forEach(function(e){e.dataset.en=e.innerHTML});
var rerender=[];
function setLang(l,skip){lang=l;document.documentElement.lang=l==="ta"?"ta":"en";try{localStorage.setItem("fnf-lang",l)}catch(e){}
  $$("[data-ta]").forEach(function(e){e.innerHTML=l==="ta"?e.dataset.ta:e.dataset.en});
  var b=$("#lang");$$("span",b).forEach(function(s,i){s.classList.toggle("on",(i===1)===(l==="ta"))});b.setAttribute("aria-label",l==="ta"?"Switch language to English":"Switch language to Tamil");
  rerender.forEach(function(f){f()});if(!skip)say(l==="ta"?"தமிழ்":"English")}
$("#lang").onclick=function(){setLang(lang==="ta"?"en":"ta")};

/* media */
$$("[data-img]").forEach(function(i){i.src=MEDIA.img[i.dataset.img]});
var film=$("#film");film.src=MEDIA.film;film.muted=true;var pr=film.play();if(pr&&pr.catch)pr.catch(function(){});
var filmPaused=false;
$("#filmpp").onclick=function(){filmPaused=!filmPaused;if(filmPaused)film.pause();else film.play().catch(function(){});this.setAttribute("aria-label",filmPaused?"Play video":"Pause video");$("span",this).textContent=filmPaused?"Play":"Pause";$("i",this).innerHTML=filmPaused?'<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>':'<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>'};
if("IntersectionObserver" in window)new IntersectionObserver(function(es){es.forEach(function(e){if(filmPaused)return;if(e.isIntersecting)film.play().catch(function(){});else film.pause()})},{threshold:.2}).observe(film);

/* marquee */
function mqRender(){var MQ=lang==="ta"?["Lift","சிறுதானிய உணவு","எடை குறைப்பு","வலிமை","கார்டியோ"]:["Lift","Millet meals","Weight loss","Strength","Cardio"];var h=MQ.map(function(x){return '<li>'+x+'</li>'}).join("");$("#mq").innerHTML=h+h}
rerender.push(mqRender);mqRender();

/* ---------- pinned hero ---------- */
var hero=$("#top"),card=$("#card"),cimg=$("img",card),title=$("#title"),hcopy=$("#hcopy"),fade=$("#fade"),cue=$("#cue"),hdr=$("#hdr"),bar=$("#bar");
var narrow=function(){return innerWidth<=600};
function ease(t){return 1-Math.pow(1-t,3)}
function heroFrame(){
  if(reduce.matches)return 1;
  var r=hero.getBoundingClientRect(),h=hero.offsetHeight-innerHeight,p=clamp(-r.top/h),e=ease(clamp(p/.5));
  var sx=narrow()?8:26,st=58,sb=narrow()?8:6,rad=narrow()?14:18;
  card.style.clipPath="inset("+(st*(1-e)).toFixed(2)+"% "+(sx*(1-e)).toFixed(2)+"% "+(sb*(1-e)).toFixed(2)+"% "+(sx*(1-e)).toFixed(2)+"% round "+(rad*(1-e)).toFixed(1)+"px)";
  cimg.style.transform="scale("+(1.3-.3*e).toFixed(3)+")";
  title.style.color=e>.3?"#fff":"";title.style.transform="translateY("+(-p*7).toFixed(2)+"vh) scale("+(1-.06*e).toFixed(3)+")";
  var q=clamp((p-.52)/.22);hcopy.style.opacity=q.toFixed(3);hcopy.style.transform="translateY("+((1-q)*40).toFixed(0)+"px)";hcopy.classList.toggle("on",q>.6);
  fade.style.opacity=clamp((p-.9)/.1).toFixed(3);cue.style.opacity=(1-clamp(p/.08)).toFixed(3);
  return p;
}
var lastY=scrollY,ticking=false;
function onScroll(){if(ticking)return;ticking=true;requestAnimationFrame(function(){ticking=false;
  var p=heroFrame(),r=hero.getBoundingClientRect(),inHero=r.bottom>hdr.offsetHeight+20,y=scrollY;
  hdr.dataset.tone=inHero?(p<.3?"ink":"light"):"solid";
  if(y>lastY+4&&y>260&&!menuOpen())hdr.classList.add("hide");else if(y<lastY-4||y<120)hdr.classList.remove("hide");
  lastY=y;var max=document.documentElement.scrollHeight-innerHeight;bar.style.transform="scaleX("+(max>0?clamp(y/max):0).toFixed(4)+")";
  chevMove();itemsVis();
})}
addEventListener("scroll",onScroll,{passive:true});addEventListener("resize",onScroll);

/* reveal on scroll */
if("IntersectionObserver" in window&&!reduce.matches){
  var io=new IntersectionObserver(function(es){es.forEach(function(e){if(!e.isIntersecting)return;io.unobserve(e.target);
    e.target.animate([{opacity:0,transform:"translateY(36px)"},{opacity:1,transform:"none"}],{duration:900,easing:"cubic-bezier(.16,1,.3,1)",fill:"backwards"})})},{threshold:.12});
  window.__io=io;$$(".reveal,.stat").forEach(function(e){io.observe(e)});
}
function observeNew(sel){if(window.__io)$$(sel).forEach(function(e){window.__io.observe(e)})}

var chev=$("#chev"),cf=$$("figure",chev);
function chevMove(){if(reduce.matches)return;var r=chev.getBoundingClientRect(),p=clamp((innerHeight-r.top)/(innerHeight*.9));
  cf.forEach(function(f,i){var d=(i-1.5),t=(1-ease(p));f.style.transform="translate("+(d*90*t).toFixed(1)+"px,"+((i%2?-1:1)*40*t).toFixed(1)+"px)";f.style.opacity=(.2+.8*p).toFixed(2)})}

function count(el){var t=+el.dataset.n,suf=el.dataset.s||"",st=performance.now();
  if(reduce.matches){el.textContent=t+suf;return}
  (function f(n){var p=Math.min((n-st)/1500,1);el.textContent=Math.round(t*ease(p))+(p>=1?suf:"");if(p<1)requestAnimationFrame(f)})(st)}
if("IntersectionObserver" in window){var co=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){co.unobserve(e.target);count(e.target)}})},{threshold:.7});$$("[data-n]").forEach(function(e){co.observe(e)})}
else $$("[data-n]").forEach(function(e){e.textContent=e.dataset.n+(e.dataset.s||"")});

/* ---------- programs ---------- */
var P=[
 {w:"Lift",k:["01 Strength","01 வலிமை"],img:"bench",pimg:"bench",t:["Build muscle, boost your metabolism and shape the body you want. Coached strength training that teaches you how to lift, not just what to lift.","தசை வளர்த்து, வளர்சிதை மாற்றத்தை அதிகரித்து, விரும்பிய உடலமைப்பைப் பெறுங்கள். எதைத் தூக்குவது மட்டுமல்ல, எப்படித் தூக்குவது என்றும் கற்றுத்தரும் பயிற்சி."],
  p:["Muscle burns calories even when you rest, which makes strength training the backbone of lasting weight loss. Every session is coached, progressive and written for your level.","ஓய்வில் இருக்கும்போதும் தசை கலோரிகளை எரிக்கிறது; அதனால் நீடித்த எடை குறைப்புக்கு வலிமைப் பயிற்சியே முதுகெலும்பு. ஒவ்வொரு அமர்வும் உங்கள் நிலைக்கு ஏற்ப வடிவமைக்கப்பட்டது."],
  l:[["Coached strength sessions, small groups","பயிற்சியாளருடன் சிறு குழு வலிமை அமர்வுகள்"],["Barbell, dumbbell and machine zones","பார்பெல், டம்பெல், இயந்திரப் பகுதிகள்"],["A progress log you can see","நீங்கள் பார்க்கக்கூடிய முன்னேற்றப் பதிவு"],["Form checks every week","வாரந்தோறும் சரியான முறைச் சோதனை"]]},
 {w:"Burn",k:["02 Cardio and Kuthu Fit","02 கார்டியோ & குத்து ஃபிட்"],img:"ellip",pimg:"kuthu",t:["HIIT, treadmills, rowers and Kuthu Fit dance cardio set to Tamil film beats. Torch calories and have fun doing it.","HIIT, டிரெட்மில், ரோயிங் மற்றும் தமிழ்ப் பட பாடல்களுக்கு குத்து ஃபிட் நடன கார்டியோ. கலோரிகளை எரியுங்கள், மகிழ்ச்சியுடன்."],
  p:["A mix of steady cardio, short hard intervals and our famous Kuthu Fit class, where a full hour of dancing to Tamil film songs burns serious calories without feeling like a workout.","நிலையான கார்டியோ, குறுகிய தீவிர இடைவெளிகள், தமிழ்ப் பட பாடல்களுக்கு ஒரு மணி நேர குத்து ஃபிட் நடனம்; உடற்பயிற்சி போலத் தோன்றாமலே அதிக கலோரிகளை எரிக்கும்."],
  l:[["HIIT and conditioning classes","HIIT மற்றும் தகுதிப் பயிற்சி வகுப்புகள்"],["Kuthu Fit dance cardio, women-only and mixed","குத்து ஃபிட்: பெண்கள் மட்டும், அனைவருக்கும்"],["Treadmills, rowers and battle ropes","டிரெட்மில், ரோயிங், போர் கயிறுகள்"],["Heart-rate zone coaching","இதயத் துடிப்பு மண்டலப் பயிற்சி"]]},
 {w:"Fuel",k:["03 South Indian nutrition","03 தென்னிந்திய ஊட்டச்சத்து"],img:"dosa",pimg:"dosa",t:["Simple eating plans built on food you already love: idli, dosa, millets, rice and sambar, with a coach who answers your questions.","உங்களுக்குப் பிடித்த உணவை அடிப்படையாகக் கொண்ட எளிய உணவுத் திட்டங்கள்: இட்லி, தோசை, சிறுதானியம், சாதம், சாம்பார்; கேள்விகளுக்கு பதில் தரும் பயிற்சியாளருடன்."],
  p:["No crash diets and no giving up rice. We build a calorie and protein target around your day, show you how to eat it with home food, and adjust when festivals and family functions get in the way.","கடுமையான உணவுக் கட்டுப்பாடு இல்லை, சாதத்தை விட வேண்டியதில்லை. உங்கள் நாளுக்கு ஏற்ற கலோரி, புரத இலக்கை வகுத்து, வீட்டு உணவுடன் எப்படிச் சாப்பிடுவது எனக் காட்டுகிறோம்; திருவிழா, குடும்ப நிகழ்வுகளில் மாற்றுகிறோம்."],
  l:[["Personal calorie and protein targets","தனிப்பட்ட கலோரி, புரத இலக்குகள்"],["Idli, dosa, millet and rice meal plans","இட்லி, தோசை, சிறுதானியம், சாத உணவுத் திட்டங்கள்"],["Vegetarian and non-vegetarian options","சைவம், அசைவம் இரண்டும்"],["Festival and family-function guidance","திருவிழா, குடும்ப நிகழ்வு வழிகாட்டல்"]]}
];
var items=$("#items"),itemEls=[];
function itemsRender(){
  items.innerHTML=P.map(function(p,i){return '<button class="item" type="button" data-p="'+i+'" aria-haspopup="dialog"><div class="item-bg"><img data-img="'+p.img+'" alt=""></div><div class="wrap item-in"><p class="item-text">'+tr(p.t[0],p.t[1])+'</p><span class="item-word" style="--w:'+(p.w.length>6?"12.5vw":"21vw")+';--wm:'+(p.w.length>6?"17vw":"30vw")+'">'+p.w+ARROW+'</span></div></button>'}).join("");
  $$("#items [data-img]").forEach(function(i){i.src=MEDIA.img[i.dataset.img]});
  itemEls=$$(".item");itemEls.forEach(function(b){b.onclick=function(){openProg(+b.dataset.p)}})}
function itemsVis(){if(matchMedia("(hover: hover) and (pointer: fine)").matches){itemEls.forEach(function(e){e.classList.remove("vis")});return}
  itemEls.forEach(function(e){var r=e.getBoundingClientRect(),c=r.top+r.height/2;e.classList.toggle("vis",c>innerHeight*.3&&c<innerHeight*.7)})}
var pdlg=$("#pdlg");
function openProg(i){var p=P[i];$("#pdk").textContent=tr(p.k[0],p.k[1]);$("#pdt").textContent=p.w;$("#pdp").innerHTML=tr(p.p[0],p.p[1]);$("#pdl").innerHTML=p.l.map(function(x){return '<li>'+tr(x[0],x[1])+'</li>'}).join("");$("#pdi").src=MEDIA.img[p.pimg];openD(pdlg)}
rerender.push(itemsRender);itemsRender();

var CO=[["Aarav Menon","Head coach, strength","தலைமைப் பயிற்சியாளர், வலிமை","Certified strength and conditioning coach, 11 years coaching.","சான்றிதழ் பெற்ற வலிமைப் பயிற்சியாளர், 11 ஆண்டு அனுபவம்."],["Priya Raman","Weight loss and nutrition","எடை குறைப்பு & ஊட்டச்சத்து","Sports nutrition diploma, specialises in sustainable fat loss.","விளையாட்டு ஊட்டச்சத்து டிப்ளோமா, நீடித்த கொழுப்புக் குறைப்பில் நிபுணர்."],["Kabir Shah","Conditioning and Kuthu Fit","தகுதிப் பயிற்சி & குத்து ஃபிட்","Former state-level athlete, runs the Burn classes.","முன்னாள் மாநில அளவிலான தடகள வீரர், Burn வகுப்புகளை நடத்துகிறார்."]];
function coachRender(){$("#cdl").innerHTML=CO.map(function(c){return '<li><strong>'+c[0]+'</strong> &middot; '+tr(c[1],c[2])+'<br><span style="color:var(--grey);font-size:15px;margin-left:1.4rem">'+tr(c[3],c[4])+'</span></li>'}).join("")}
rerender.push(coachRender);coachRender();
$("#meet").onclick=function(){openD($("#cdlg"))};

var ST2=[["Post-delivery recovery","பிரசவத்திற்குப் பின் மீட்பு"],["PCOS-friendly plans","PCOS-க்கு ஏற்ற திட்டங்கள்"],["Thyroid-friendly plans","தைராய்டுக்கு ஏற்ற திட்டங்கள்"],["Diabetes-friendly plans","நீரிழிவுக்கு ஏற்ற திட்டங்கள்"],["Seniors","மூத்தோர்"],["College students","கல்லூரி மாணவர்கள்"],["IT professionals","ஐடி ஊழியர்கள்"],["Wedding countdown","திருமண கவுண்ட்டவுன்"]];
function stRender(){$("#stages").innerHTML=ST2.map(function(s){return '<li>'+tr(s[0],s[1])+'</li>'}).join("")}
rerender.push(stRender);stRender();

/* seasons */
var SE=[["Jan","ஜன","Pongal Reset","பொங்கல் ரீசெட்","21 days to start the year strong. Sweet pongal is allowed.","ஆண்டை வலிமையாகத் தொடங்க 21 நாட்கள். சர்க்கரைப் பொங்கலுக்கும் அனுமதி."],["Apr to May","ஏப்ரல் முதல் மே","Summer Shred","கோடை ஷ்ரெட்","Early-morning and evening batches, hydration coaching and cooling meals.","அதிகாலை, மாலை பேட்ச்கள், நீர்ச்சத்து பயிற்சி, குளிர்ச்சியான உணவுகள்."],["Oct to Nov","அக் முதல் நவ","Deepavali Balance","தீபாவளி சமநிலை","Enjoy the sweets and snacks, keep your streak. A plan for the whole festival week.","இனிப்பு, பலகாரம் சாப்பிடுங்கள், உங்கள் தொடர்ச்சியை விடாதீர்கள். திருவிழா வாரம் முழுவதற்கும் திட்டம்."],["Any month","எந்த மாதமும்","Wedding Countdown","திருமண கவுண்ட்டவுன்","12 to 16 weeks of focused training before the big day.","பெரிய நாளுக்கு முன் 12 முதல் 16 வாரங்கள் கவனம் செலுத்திய பயிற்சி."]];
function seRender(){$("#sgrid").innerHTML=SE.map(function(s){return '<button class="sc" type="button" data-trial><span class="label">'+tr(s[0],s[1])+'</span><h3>'+tr(s[2],s[3])+'</h3><p>'+tr(s[4],s[5])+'</p><i>'+ARROW+'</i></button>'}).join("")}
rerender.push(seRender);seRender();

/* ---------- plans ---------- */
var PL=[
 {n:["Day pass","ஒரு நாள் அனுமதி"],price:199,unit:["/ day","/ நாள்"],tag:["Try us for a day.","ஒரு நாள் முயற்சி செய்யுங்கள்."],f:[["Full gym floor access for the day","நாள் முழுவதும் ஜிம் அணுகல்"],["Cardio deck and strength zone","கார்டியோ, வலிமைப் பகுதி"],["Locker and filtered water","லாக்கர், சுத்திகரிக்கப்பட்ட குடிநீர்"],["A free coach walk-through","இலவச பயிற்சியாளர் வழிகாட்டல்"]]},
 {n:["Monthly","மாதாந்திரம்"],price:1999,unit:["/ month","/ மாதம்"],tag:["Find your rhythm.","உங்கள் தாளத்தைக் கண்டறியுங்கள்."],f:[["Unlimited access, 5:30 AM to 10:30 PM","வரம்பற்ற அணுகல், காலை 5:30 முதல் இரவு 10:30"],["Welcome session with a coach","பயிற்சியாளருடன் வரவேற்பு அமர்வு"],["App-based workout plans","செயலி வழி உடற்பயிற்சித் திட்டங்கள்"],["Body scan every month","மாதந்தோறும் உடல் ஸ்கேன்"]]},
 {n:["Quarterly","காலாண்டு"],price:5397,unit:["/ 3 months","/ 3 மாதம்"],eff:1799,save:10,feat:1,badge:["Most loved","அதிகம் விரும்பப்படுவது"],tag:["Build the habit.","பழக்கத்தை உருவாக்குங்கள்."],f:[["Everything in Monthly","மாதாந்திரத்தின் அனைத்தும்"],["Weekly coach check-in","வாராந்திர பயிற்சியாளர் சந்திப்பு"],["Personal nutrition plan, veg or non-veg","சைவம்/அசைவம் தனிப்பட்ட உணவுத் திட்டம்"],["HIIT and strength classes","HIIT, வலிமை வகுப்புகள்"]]},
 {n:["Yearly","ஆண்டு"],price:19190,unit:["/ year","/ ஆண்டு"],eff:1599,save:20,badge:["Best value","சிறந்த மதிப்பு"],yel:1,tag:["Commit to the change.","மாற்றத்திற்கு உறுதி எடுங்கள்."],f:[["Everything in Quarterly","காலாண்டின் அனைத்தும்"],["Two personal training sessions every month","மாதம் இரண்டு தனிப்பட்ட பயிற்சி அமர்வுகள்"],["Plan reset and body scan every 3 months","3 மாதத்திற்கு ஒருமுறை திட்ட மாற்றம், உடல் ஸ்கேன்"],["Freeze your plan for up to 30 days","30 நாள் வரை திட்டத்தை நிறுத்தலாம்"]]},
 {n:["Couple","தம்பதியர்"],price:3518,unit:["/ month, for two","/ மாதம், இருவருக்கு"],eff:1759,effTxt:["each","ஒவ்வொருவருக்கும்"],save:12,tag:["Train together.","சேர்ந்து பயிற்சி செய்யுங்கள்."],f:[["Two memberships, one price","இரண்டு உறுப்பினர், ஒரே விலை"],["Joint welcome session","கூட்டு வரவேற்பு அமர்வு"],["Partner workouts and shared goals","இணைந்த பயிற்சிகள், பொது இலக்குகள்"],["Both get a nutrition plan","இருவருக்கும் உணவுத் திட்டம்"]]},
 {n:["Professional","தொழில்முறை"],price:2799,unit:["/ month","/ மாதம்"],tag:["Built for busy schedules.","பரபரப்பான நேரத்திற்கு ஏற்றது."],f:[["Priority booking at 5:30 AM and after 8 PM","காலை 5:30, இரவு 8க்குப் பின் முன்னுரிமை முன்பதிவு"],["Two personal training sessions a month","மாதம் இரண்டு தனிப்பட்ட பயிற்சி அமர்வுகள்"],["Desk-job posture and mobility plan","அலுவலக வேலைக்கான உடல்நிலை, இயக்கத் திட்டம்"],["Freeze when you travel","பயணத்தின்போது நிறுத்தலாம்"]],disc:["Teams of 5 or more save 15%","5 பேர் அல்லது அதற்கு மேற்பட்ட குழுவுக்கு 15% தள்ளுபடி"]}
];
function inr(n){return "₹"+Math.round(n).toLocaleString("en-IN")}
function plRender(){
  $("#planGrid").innerHTML=PL.map(function(p){
    var badge=p.badge?'<span class="tagp'+(p.yel?' yel':'')+'">'+tr(p.badge[0],p.badge[1])+'</span>':'<span class="label">'+tr("Plan","திட்டம்")+'</span>';
    var save=p.save?'<span class="save">'+tr("Save ","சேமிப்பு ")+p.save+'%</span>':'';
    var eff=p.eff?'<p class="eff">'+inr(p.eff)+' '+tr(p.effTxt?"per person / month":"effective / month",p.effTxt?"ஒருவருக்கு / மாதம்":"மாதத்திற்கு")+'</p>':'';
    return '<article class="plan'+(p.feat?' feat':'')+'">'+badge+'<h3>'+tr(p.n[0],p.n[1])+'</h3><div class="price">'+inr(p.price)+' <small>'+tr(p.unit[0],p.unit[1])+'</small></div>'+save+eff+'<p class="ptag">'+tr(p.tag[0],p.tag[1])+'</p><ul>'+p.f.map(function(x){return '<li>'+tr(x[0],x[1])+'</li>'}).join("")+'</ul>'+(p.disc?'<p class="pdisc">'+tr(p.disc[0],p.disc[1])+'</p>':'')+'<button class="btn'+(p.feat?' light':'')+'" type="button" data-trial><span>'+tr("Choose "+p.n[0],p.n[1]+" தேர்வு செய்")+'</span><i><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17L17 7M8 7h9v9"/></svg></i></button></article>'}).join("");
  $("#disc").innerHTML=[["Pay quarterly, save 10%","காலாண்டுக் கட்டணத்தில் 10% சேமிப்பு"],["Pay yearly, save 20%","ஆண்டுக் கட்டணத்தில் 20% சேமிப்பு"],["Couples save 12%","தம்பதிகளுக்கு 12% தள்ளுபடி"],["Teams of 5+ save 15%","5+ குழுவுக்கு 15% தள்ளுபடி"],["Students ₹999 with college ID","கல்லூரி அடையாள அட்டையுடன் மாணவர்களுக்கு ₹999"]].map(function(d){return '<span>'+tr(d[0],d[1])+'</span>'}).join("");
  observeNew(".plan");
}
rerender.push(plRender);plRender();

/* testimonials */
var T=[["I had tried every crash diet there is. Priya showed me how to eat idli and rice and still lose weight. Twelve kilos down and I finally keep it off.","எல்லா கடுமையான உணவுக் கட்டுப்பாடுகளையும் முயன்றேன். இட்லி, சாதம் சாப்பிட்டுக்கொண்டே எடை குறைக்கலாம் என்று பிரியா காட்டினார். பன்னிரண்டு கிலோ குறைந்து, இப்போது அதைத் தக்கவைக்கிறேன்.","Meenakshi R.","மீனாட்சி ஆர்.","Lost 12 kg in 24 weeks","24 வாரத்தில் 12 கிலோ குறைவு"],["I came in barely able to climb stairs. Six months later I deadlift my own weight, and my back pain is gone. The 5:30 AM batch changed my day.","படிகள் ஏறவே சிரமப்பட்டு வந்தேன். ஆறு மாதத்தில் என் எடையையே தூக்குகிறேன், முதுகு வலி போய்விட்டது. 5:30 மணி பேட்ச் என் நாளையே மாற்றியது.","Karthik S.","கார்த்திக் எஸ்.","Strength member","வலிமை உறுப்பினர்"],["Women-only Kuthu Fit is the best hour of my week. I sweat, I laugh, and I do not even feel like I am exercising.","பெண்கள் மட்டும் குத்து ஃபிட் என் வாரத்தின் சிறந்த மணி நேரம். வியர்க்கிறது, சிரிக்கிறேன், உடற்பயிற்சி செய்வதாகவே தோன்றவில்லை.","Divya P.","திவ்யா பி.","Kuthu Fit regular","குத்து ஃபிட் உறுப்பினர்"],["The meal plan fits the food we cook at home, so I never feel like I am on a diet. My coach checks in every week and notices when I skip.","உணவுத் திட்டம் எங்கள் வீட்டுச் சமையலுக்கு ஏற்றது; டயட்டில் இருப்பது போலவே தோன்றவில்லை. பயிற்சியாளர் வாரந்தோறும் விசாரிப்பார், நான் தவறினால் கவனிப்பார்.","Faizal M.","ஃபைசல் எம்.","Quarterly member","காலாண்டு உறுப்பினர்"]];
var qi=0,qt;
$("#dots").innerHTML=T.map(function(_,i){return '<button type="button" aria-label="Story '+(i+1)+'"></button>'}).join("");
function showQ(i,user){qi=(i+T.length)%T.length;var q=$("#q");q.style.opacity=0;setTimeout(function(){q.innerHTML="&ldquo;"+tr(T[qi][0],T[qi][1])+"&rdquo;";$("#qn").textContent=tr(T[qi][2],T[qi][3]);$("#qr").textContent=tr(T[qi][4],T[qi][5]);q.style.opacity=1},user?200:0);
  $$("#dots button").forEach(function(b,j){b.setAttribute("aria-current",j===qi)});clearInterval(qt);if(!reduce.matches)qt=setInterval(function(){showQ(qi+1)},7000)}
$$("#dots button").forEach(function(b,i){b.onclick=function(){showQ(i,true)}});
rerender.push(function(){showQ(qi,false)});showQ(0);

/* ---------- calculator and South Indian meal plan ---------- */
var sex="f",diet="veg";
$$("[data-sex]").forEach(function(b){b.onclick=function(){sex=b.dataset.sex;$$("[data-sex]").forEach(function(x){x.setAttribute("aria-pressed",x===b)});calc()}});
["cA","cH","cW","cG","cAct","cT"].forEach(function(id){$("#"+id).addEventListener("input",calc)});
function fmt(n,d){return n.toLocaleString("en-IN",{maximumFractionDigits:d||0})}
var F={idli:["idli","இட்லி",58,""],dosa:["dosa","தோசை",133,""],ragi:["ragi dosa","கேழ்வரகு தோசை",110,""],pongal:["millet pongal","சிறுதானிய பொங்கல்",220,"cup"],sambar:["sambar","சாம்பார்",130,"cup"],cchut:["coconut chutney","தேங்காய் சட்னி",22,"tbsp"],tchut:["tomato chutney","தக்காளி சட்னி",15,"tbsp"],rice:["rice","சாதம்",205,"cup"],dal:["dal","பருப்பு",150,"cup"],keerai:["keerai poriyal","கீரை பொரியல்",90,"cup"],veg:["vegetable poriyal","காய்கறி பொரியல்",100,"cup"],curd:["curd","தயிர்",60,"bowl"],bmilk:["buttermilk","மோர்",40,"glass"],sundal:["sundal","சுண்டல்",180,"cup"],banana:["banana","வாழைப்பழம்",105,""],guava:["guava","கொய்யா",70,""],chana:["roasted chana","வறுத்த கடலை",110,"30 g"],pnut:["peanuts","வேர்க்கடலை",115,"20 g"],paneer:["paneer","பன்னீர்",130,"50 g"],cuc:["cucumber salad","வெள்ளரி சாலட்",25,"bowl"],egg:["boiled egg","வேகவைத்த முட்டை",75,""],omelette:["omelette","ஆம்லெட்",95,""],fish:["fish curry","மீன் குழம்பு",160,"100 g"],chick:["chicken curry","கோழிக் குழம்பு",170,"100 g"],gchick:["grilled chicken","வறுத்த கோழி",165,"100 g"]};
var MEALS={
 veg:{1200:[[["idli",2],["sambar",1],["cchut",2]],[["rice",1],["sambar",1],["keerai",1],["curd",1]],[["sundal",.5],["bmilk",1]],[["ragi",2],["tchut",2],["cuc",1]]],
      1500:[[["idli",3],["sambar",1],["cchut",2]],[["rice",1.5],["dal",1],["veg",1],["curd",1]],[["guava",1],["chana",1]],[["ragi",2],["paneer",1],["tchut",2],["cuc",1]]],
      1800:[[["pongal",1],["sambar",1],["cchut",2]],[["rice",1.5],["dal",1],["keerai",1],["veg",1],["curd",1]],[["banana",1],["pnut",1],["bmilk",1]],[["ragi",2],["paneer",1],["tchut",2],["cuc",1]]],
      2100:[[["dosa",2],["sambar",1],["cchut",2],["banana",1]],[["rice",2],["dal",1],["keerai",1],["veg",1],["curd",1]],[["sundal",1],["bmilk",1]],[["ragi",3],["paneer",1],["tchut",2],["cuc",1]]]},
 nonveg:{1200:[[["egg",2],["idli",2]],[["rice",1],["fish",1],["keerai",1]],[["guava",1],["bmilk",1]],[["ragi",1],["gchick",1],["cuc",1],["tchut",2]]],
      1500:[[["omelette",2],["idli",3]],[["rice",1.5],["fish",1],["keerai",1],["curd",1]],[["guava",1],["bmilk",1]],[["ragi",2],["chick",1],["cuc",1],["tchut",2]]],
      1800:[[["omelette",1],["dosa",2],["cchut",2]],[["rice",2],["fish",1],["keerai",1],["curd",1]],[["banana",1],["bmilk",1],["egg",1]],[["ragi",2],["gchick",1],["cuc",1]]],
      2100:[[["omelette",2],["dosa",2],["cchut",2],["banana",1]],[["rice",2],["chick",1.5],["keerai",1],["curd",1]],[["sundal",1],["bmilk",1]],[["ragi",2],["gchick",1.5],["cuc",1]]]}};
var UNIT={cup:["cup","கப்"],tbsp:["tbsp","மே.க."],bowl:["bowl","கிண்ணம்"],glass:["glass","டம்ளர்"]};
function qtxt(f,q){var d=F[f],u=d[3],qs=q===.5?"½":(q===1.5?"1½":String(q));
  if(/ g$/.test(u)){var g=parseInt(u,10);return Math.round(q*g)+" g"}
  if(u&&UNIT[u])return qs+" "+tr(UNIT[u][0],UNIT[u][1]);return qs}
function band(t){var bs=[1200,1500,1800,2100],b=bs[0],i;for(i=0;i<bs.length;i++)if(Math.abs(bs[i]-t)<Math.abs(b-t))b=bs[i];return b}
var lastTarget=1500;
function mealRender(){
  var b=band(lastTarget),plan=MEALS[diet][b],names=[["Breakfast","காலை உணவு"],["Lunch","மதிய உணவு"],["Evening snack","மாலை சிற்றுண்டி"],["Dinner","இரவு உணவு"]],tot=0,rows="";
  plan.forEach(function(m,i){var k=0,lines=m.map(function(x){var d=F[x[0]];k+=d[2]*x[1];return '<li><span>'+tr(d[0],d[1])+'</span><b>'+qtxt(x[0],x[1])+'</b></li>'}).join("");tot+=k;
    rows+='<div class="ml"><div class="mh"><span class="label" style="color:#a9abab">'+tr(names[i][0],names[i][1])+'</span><b>'+fmt(k)+' kcal</b></div><ul>'+lines+'</ul></div>'});
  $("#meal").innerHTML='<div class="meal-grid"><div class="meal-img"><img src="'+(diet==="veg"?MEDIA.img.idli:MEDIA.img.biryani)+'" alt="'+(diet==="veg"?"Idli served with chutney and sambar":"Chicken biryani served on a plate")+'"></div><div><p class="label" style="color:#a9abab">'+tr("A sample day on a Tamil Nadu plate","தமிழ்நாட்டுத் தட்டில் ஒரு நாள்")+'</p><h3 class="mt">'+tr("About ","சுமார் ")+fmt(tot)+' kcal</h3><div class="seg dsw" role="group" aria-label="Diet"><button type="button" data-diet="veg" aria-pressed="'+(diet==="veg")+'">'+tr("Vegetarian","சைவம்")+'</button><button type="button" data-diet="nonveg" aria-pressed="'+(diet==="nonveg")+'">'+tr("Non-vegetarian","அசைவம்")+'</button></div><div class="mls">'+rows+'</div><p class="note">'+tr("Tamil Nadu heat: drink 3 to 3.5 litres of water a day, more on training days. Values are approximate and depend on portion size.","தமிழ்நாட்டு வெப்பம்: தினமும் 3 முதல் 3.5 லிட்டர் தண்ணீர் குடியுங்கள்; பயிற்சி நாட்களில் இன்னும் அதிகம். மதிப்புகள் தோராயமானவை, அளவைப் பொறுத்தவை.")+'</p></div></div>';
  $$("[data-diet]").forEach(function(x){x.onclick=function(){diet=x.dataset.diet;mealRender()}});
}
function bmiCat(b){return b<18.5?tr("Underweight","எடை குறைவு"):b<23?tr("Healthy range","ஆரோக்கிய வரம்பு"):b<25?tr("Overweight","அதிக எடை"):tr("Obese","உடல் பருமன்")}
function calc(){
  var a=+$("#cA").value,h=+$("#cH").value,w=+$("#cW").value,g=+$("#cG").value,f=+$("#cAct").value,wk=+$("#cT").value,res=$("#res");
  $("#cTo").textContent=wk+tr(" weeks"," வாரங்கள்");
  if(!(a>=16&&a<=80&&h>=130&&h<=220&&w>=35&&w<=250&&g>=35&&g<=250)){res.innerHTML='<p class="warn">'+tr("Enter an age from 16 to 80, a height from 130 to 220 cm and weights from 35 to 250 kg.","16 முதல் 80 வரை வயது, 130 முதல் 220 செ.மீ உயரம், 35 முதல் 250 கி.கி எடையை உள்ளிடவும்.")+'</p>';return}
  var bmr=10*w+6.25*h-5*a+(sex==="m"?5:-161),tdee=bmr*f,diff=w-g,floor=sex==="m"?1500:1200,bmi=w/Math.pow(h/100,2);
  var asian=tr("Asian cut-offs","ஆசிய வரம்புகள்");
  if(diff<=0){lastTarget=tdee;res.innerHTML='<div><p class="label" style="color:#a9abab">'+tr("Daily calories to maintain","பராமரிக்க தினசரி கலோரிகள்")+'</p><div class="big-num">'+fmt(tdee)+'<small>kcal</small></div></div><p class="note" style="color:#fff;font-size:16px">'+tr("Your goal weight is at or above your current weight. To build muscle, eat about 250 to 300 kcal above this and lift three times a week.","உங்கள் இலக்கு எடை தற்போதைய எடைக்கு சமம் அல்லது அதிகம். தசை வளர்க்க இதைவிட 250 முதல் 300 kcal கூடுதலாகச் சாப்பிட்டு, வாரம் மூன்று முறை பயிற்சி செய்யுங்கள்.")+'</p><div class="kv"><div><span>'+tr("Resting burn (BMR)","ஓய்வு எரிப்பு (BMR)")+'</span><b>'+fmt(bmr)+' kcal</b></div><div><span>'+tr("Protein","புரதம்")+'</span><b>'+fmt(1.8*w)+' g</b></div></div>';mealRender();return}
  var want=diff/wk,max=w*.01,rate=Math.min(want,max),deficit=rate*7700/7,target=Math.max(floor,tdee-deficit),real=(tdee-target)*7/7700,weeks=Math.max(1,Math.ceil(diff/Math.max(real,.05)));
  lastTarget=target;
  var limited=target===floor&&tdee-deficit<floor,fast=want>max||limited;
  var N=Math.min(weeks,104),pts=[],i;for(i=0;i<=N;i++)pts.push([i,w-real*i>g?w-real*i:g]);
  var W=100,H=60,x=function(v){return v/N*W},y=function(v){return H-(v-g)/(w-g)*(H-6)-3};
  var d=pts.map(function(p,k){return (k?"L":"M")+x(p[0]).toFixed(2)+" "+y(p[1]).toFixed(2)}).join("");
  res.innerHTML='<div><p class="label" style="color:#a9abab">'+tr("Eat about this much each day","தினமும் சுமார் இவ்வளவு சாப்பிடுங்கள்")+'</p><div class="big-num">'+fmt(target,0)+'<small>kcal</small></div></div>'+
  (fast?'<p class="warn">'+(limited?tr("Your timeframe needs a deficit below the safe minimum, so we set a floor of "+fmt(floor)+" kcal.","உங்கள் காலத்திற்கு பாதுகாப்பான குறைந்தபட்சத்திற்கும் குறைவான கலோரி தேவைப்படும்; எனவே "+fmt(floor)+" kcal குறைந்தபட்சமாக வைத்துள்ளோம்."):tr("That is faster than the 1% of body weight per week we recommend, so we capped your pace.","இது வாரம் 1% உடல் எடை என்ற பரிந்துரையைவிட வேகம்; எனவே வேகத்தைக் கட்டுப்படுத்தினோம்."))+' '+tr("Your goal takes about "+weeks+" weeks.","உங்கள் இலக்குக்கு சுமார் "+weeks+" வாரங்கள் ஆகும்.")+'</p>':'')+
  '<div class="kv"><div><span>'+tr("Maintenance","பராமரிப்பு")+'</span><b>'+fmt(tdee)+' kcal</b></div><div><span>'+tr("Daily deficit","தினசரி குறைப்பு")+'</span><b>'+fmt(tdee-target)+' kcal</b></div><div><span>'+tr("Expected loss","எதிர்பார்க்கும் குறைவு")+'</span><b>'+fmt(real,2)+tr(" kg / week"," கி.கி / வாரம்")+'</b></div><div><span>'+tr("Time to goal","இலக்கை அடைய")+'</span><b>'+weeks+tr(" weeks"," வாரங்கள்")+'</b></div><div><span>'+tr("Protein target","புரத இலக்கு")+'</span><b>'+fmt(1.8*g)+tr(" g / day"," கி / நாள்")+'</b></div><div><span>BMI ('+asian+')</span><b>'+fmt(bmi,1)+' &middot; '+bmiCat(bmi)+'</b></div></div>'+
  '<div class="chart" role="img" aria-label="Projected weight from '+fmt(w,1)+' to '+fmt(g,1)+' kilograms over '+weeks+' weeks"><svg viewBox="0 0 100 60" preserveAspectRatio="none"><path d="'+d+'L100 60 L0 60Z" fill="rgba(242,131,34,.16)"/><path d="'+d+'" fill="none" stroke="#F28322" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg></div><div class="out"><span>'+tr("Now ","இப்போது ")+fmt(w,1)+' kg</span><span>'+tr("Week ","வாரம் ")+N+': '+fmt(g,1)+' kg</span></div>';
  mealRender();
}
rerender.push(calc);calc();

/* ---------- menu ---------- */
var burger=$("#burger"),menu=$("#menu");function menuOpen(){return burger.getAttribute("aria-expanded")==="true"}
function setMenu(o,ret){burger.setAttribute("aria-expanded",o);burger.setAttribute("aria-label",o?"Close menu":"Open menu");menu.classList.toggle("open",o);menu.inert=!o;document.body.classList.toggle("lock",o);document.body.classList.toggle("menu-open",o);$$("main,footer").forEach(function(e){e.inert=o});hdr.dataset.tone=o?"light":hdr.dataset.tone;hdr.classList.remove("hide");if(o){var a=$("a",menu);a&&a.focus()}if(ret)burger.focus();if(!o)onScroll()}
burger.onclick=function(){setMenu(!menuOpen())};
document.addEventListener("keydown",function(e){if(!menuOpen())return;if(e.key==="Escape"){e.preventDefault();setMenu(false,true)}if(e.key==="Tab"){var f=$$("a,button",menu).concat([burger]).filter(function(x){return x.getClientRects().length}),a=f[0],z=f[f.length-1];if(e.shiftKey&&document.activeElement===a){e.preventDefault();z.focus()}else if(!e.shiftKey&&document.activeElement===z){e.preventDefault();a.focus()}}});
matchMedia("(min-width: 1001px)").addEventListener("change",function(e){if(e.matches)setMenu(false)});
$$("a[href^='#']").forEach(function(a){a.addEventListener("click",function(e){var id=a.getAttribute("href");if(id.length<2)return;var t=$(id);if(!t)return;e.preventDefault();if(menuOpen())setMenu(false);t.scrollIntoView({behavior:reduce.matches?"auto":"smooth",block:"start"})})});

/* ---------- dialogs, toast, WhatsApp ---------- */
var toast=$("#toast"),tt;function say(m){toast.textContent=m;toast.classList.add("on");clearTimeout(tt);tt=setTimeout(function(){toast.classList.remove("on")},1800)}
function wa(msg){return "https://wa.me/?text="+encodeURIComponent(msg)}
["waCta","waFoot","waFloat"].forEach(function(id){$("#"+id).href=wa("Hi FitNFine, I'd like to book a free demo session.")});
function openD(d){if(typeof d.showModal!=="function")return;if(d.open)return;d.showModal();document.body.classList.add("lock")}
$$("dialog").forEach(function(d){d.addEventListener("close",function(){if(!$("dialog[open]")&&!menuOpen())document.body.classList.remove("lock")});$$("[data-close]",d).forEach(function(b){b.onclick=function(){d.close()}});d.addEventListener("click",function(e){if(e.target===d)d.close()})});
var trial=$("#trial");
document.addEventListener("click",function(e){var b=e.target.closest("[data-trial]");if(!b)return;e.preventDefault();$$("dialog[open]").forEach(function(d){if(d!==trial)d.close()});if(menuOpen())setMenu(false);trial.classList.remove("done");$("#tForm").reset();$$(".err",trial).forEach(function(x){x.textContent=""});openD(trial);setTimeout(function(){$("#tn").focus()},50)});
$("#tForm").addEventListener("submit",function(e){e.preventDefault();var n=$("#tn").value.trim(),p=$("#tp").value.replace(/[\s-]/g,"").replace(/^(\+91|91|0)(?=\d{10}$)/,""),g=$("#tg").value,okp=/^[6-9]\d{9}$/.test(p);
  $("#etn").textContent=n?"":tr("Please add your name.","உங்கள் பெயரைச் சேர்க்கவும்.");$("#etp").textContent=okp?"":tr("Enter a valid 10-digit mobile number.","சரியான 10 இலக்க கைபேசி எண்ணை உள்ளிடவும்.");$("#etg").textContent=g?"":tr("Please choose a goal.","ஒரு இலக்கைத் தேர்ந்தெடுக்கவும்.");
  if(!n||!okp||!g)return;
  var msg="Hi FitNFine, I'd like to book a free demo.\nName: "+n+"\nMobile: +91 "+p+"\nGoal: "+g+"\nPreferred time: "+$("#tt").value+"\nCoaching language: "+$("#tl").value;
  $("#tsent").textContent=tr("Thanks, "+n.split(" ")[0]+". This is a demo, so nothing was sent. In the real thing, this message would open in WhatsApp:","நன்றி, "+n.split(" ")[0]+". இது டெமோ, எதுவும் அனுப்பப்படவில்லை. உண்மையில் இந்தச் செய்தி வாட்ஸ்அப்பில் திறக்கும்:");
  $("#tmsg").textContent=msg;$("#tWa").href=wa(msg);trial.classList.add("done")});

setLang(lang,true);onScroll();heroFrame();setTimeout(onScroll,300);
})();
