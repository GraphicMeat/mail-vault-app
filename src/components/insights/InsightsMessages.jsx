import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import {X} from 'lucide-react';
import {Button} from '../ui/Button';
import {EmailViewer} from '../EmailViewer';
import {useT,getLocale} from '../../i18n';

const ROW_HEIGHT=76, WINDOW_ROWS=24, OVERSCAN=4;
export default function InsightsMessages({messages=[],loading=false,onClose,onOpenMessage,detailOpen=false,onDetailChange,onCloseReader,onCancel,onComposeReply}) {
  const t = useT();
  const [scrollTop,setScrollTop]=useState(0),[active,setActive]=useState(0),[pending,setPending]=useState(null),[error,setError]=useState(null);
  const viewport=useRef(null),region=useRef(null),request=useRef(0),focusRow=useRef(false),wasDetailOpen=useRef(detailOpen);
  useEffect(()=>{region.current?.focus();return()=>{++request.current;};},[]);
  useEffect(()=>{setScrollTop(0);setActive(0);if(viewport.current)viewport.current.scrollTop=0;},[messages]);
  const start=Math.max(0,Math.floor(scrollTop/ROW_HEIGHT)-OVERSCAN),end=Math.min(messages.length,start+WINDOW_ROWS);
  useLayoutEffect(()=>{if(focusRow.current){viewport.current?.querySelector(`[data-index="${active}"]`)?.focus();focusRow.current=false;}},[active,start]);
  useLayoutEffect(()=>{
    if(wasDetailOpen.current && !detailOpen) viewport.current?.querySelector(`[data-index="${active}"]`)?.focus();
    wasDetailOpen.current=detailOpen;
  },[detailOpen,active]);
  const open=async(match)=>{
    const id=++request.current;setPending(match.key);setError(null);onDetailChange?.(false);
    try {const opened=await onOpenMessage?.(match);if(id===request.current && opened!==false)onDetailChange?.(true);}
    catch(error){if(id===request.current && error.name!=='AbortError'){setError(t('insights.openMessageFailed'));onDetailChange?.(false);}}
    finally {if(id===request.current)setPending(null);}
  };
  const move=(event,index)=>{
    const next=event.key==='ArrowDown'?Math.min(messages.length-1,index+1):event.key==='ArrowUp'?Math.max(0,index-1):event.key==='Home'?0:event.key==='End'?messages.length-1:null;
    if(next===null)return;event.preventDefault();setActive(next);focusRow.current=true;
    if(next<start+OVERSCAN || next>=start+WINDOW_ROWS-OVERSCAN){const top=Math.max(0,next-OVERSCAN)*ROW_HEIGHT;viewport.current.scrollTop=top;setScrollTop(top);}
  };
  const dateText=value=>value?new Date(value).toLocaleString(getLocale()==='zh-Hans'?'zh-CN':getLocale(),{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):t('insights.chart.unknownDate');
  return <section ref={region} tabIndex={-1} className="insights-messages" data-testid="insights-matches" aria-label={t('insights.matches')}>
    <header><div><h2>{t('insights.matches')}</h2><p aria-live="polite">{t('insights.messageCount',{count:messages.length})}</p></div>
      <Button icon variant="ghost" size="sm" data-testid="insights-close-matches" title={t('insights.closeMatches')} onClick={onClose}><X size={16}/></Button></header>
    {loading && <p role="status">{t('insights.querying')}</p>}
    {error && <p role="alert" className="insights-error">{error}</p>}
    <div className={`insights-message-panes ${detailOpen?'has-reader':''}`}>
      <div ref={viewport} className="insights-message-list" data-testid="insights-message-list" onScroll={e=>setScrollTop(e.currentTarget.scrollTop)}>
        <ul aria-label={t('insights.matches')} style={{height:messages.length*ROW_HEIGHT,position:'relative'}}>
          {messages.slice(start,end).map((match,offset)=>{
            const index=start+offset,copy=match.copies?.[0];
            return <li key={match.key} aria-posinset={index+1} aria-setsize={messages.length} style={{position:'absolute',height:ROW_HEIGHT,top:index*ROW_HEIGHT,left:0,right:0}}>
              <button type="button" data-testid="insights-match" data-key={match.key} data-account-id={copy?.accountId} data-mailbox={copy?.mailbox} data-uid={copy?.uid} data-index={index}
                onKeyDown={e=>move(e,index)} tabIndex={index===active?0:-1} onFocus={()=>setActive(index)} onClick={()=>open(match)} aria-busy={pending===match.key}>
                <strong>{match.subject || t('insights.untitled')}</strong><span>{match.from?.name || match.from?.address}</span>
                <small>{dateText(match.eventAt)} · {copy?.mailbox}</small>
              </button>
            </li>;
          })}
        </ul>
        {!loading && !messages.length && <p className="insights-empty">{t('insights.noMatches')}</p>}
      </div>
      {detailOpen && <div className="insights-detail" data-testid="insights-reader">
        <Button variant="ghost" size="sm" onClick={onCloseReader}><X size={14}/>{t('insights.closeReader')}</Button>
        <EmailViewer onComposeReply={onComposeReply} onClose={onCloseReader}/>
      </div>}
    </div>
  </section>;
}
