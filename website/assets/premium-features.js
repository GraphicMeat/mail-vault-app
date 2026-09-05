(() => {
 const features=[...document.querySelectorAll('.mv-premium-detail')];
 function openFeature(hash,scroll=false){
  const feature=features.find(el=>'#'+el.id===hash);
  if(!feature)return;
  features.forEach(el=>{el.open=el===feature;});
  if(scroll)feature.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
 }
 document.querySelectorAll('.mv-premium-links a').forEach(a=>a.addEventListener('click',()=>openFeature(a.hash)));
 window.addEventListener('hashchange',()=>openFeature(location.hash,true));
 features.forEach(el=>el.addEventListener('toggle',()=>{if(el.open)features.forEach(other=>{if(other!==el)other.open=false;});}));
 openFeature(location.hash);
})();
