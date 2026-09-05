(() => {
 const nav=document.querySelector('.mv-feature-nav');
 const links=[...nav.querySelectorAll('a')];
 const menu=nav.querySelector('details');
 const mobile=matchMedia('(max-width:760px)');
 function adapt(){menu.open=!mobile.matches;}
 adapt();mobile.addEventListener('change',adapt);
 function active(id){links.forEach(a=>{if(a.hash==='#'+id)a.setAttribute('aria-current','location');else a.removeAttribute('aria-current');});}
 links.forEach(a=>a.addEventListener('click',()=>{active(a.hash.slice(1));if(mobile.matches)menu.open=false;}));
 const observer=new IntersectionObserver(entries=>{entries.forEach(e=>{if(e.isIntersecting)active(e.target.id);});},{rootMargin:'-100px 0px -55% 0px'});
 links.forEach(a=>{const section=document.getElementById(a.hash.slice(1));if(section)observer.observe(section);});
 active(location.hash.slice(1)||'email-management');
})();
