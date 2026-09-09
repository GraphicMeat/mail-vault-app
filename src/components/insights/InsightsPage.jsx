import React, {useEffect,useRef,useState} from 'react';
import {ArrowLeft,RefreshCw,X} from 'lucide-react';
import {useInsightsStore} from '../../stores/insightsStore';
import {useMailStore} from '../../stores/mailStore';
import {useSettingsStore} from '../../stores/settingsStore';
import {Button} from '../ui/Button';
import {useT,getLocale} from '../../i18n';
import SenderMap from './SenderMap';
import SenderTimeline from './SenderTimeline';
import ActivityCalendar from './ActivityCalendar';
import InsightsMessages from './InsightsMessages';
import {openInsightsMessage} from '../../services/workflows/openInsightsMessage';
import {cancelInsightsSelection} from '../../services/workflows/selectEmail';
import '../../styles/insights.css';

const locale=()=>getLocale()==='zh-Hans'?'zh-CN':getLocale();
export default function InsightsPage({onClose,onComposeReply}) {
  const t = useT();
  const state=useInsightsStore();
  const accounts=useMailStore(s=>s.accounts);
  const aliases=useSettingsStore(s=>s.sendAsAddresses);
  const accountSignature=JSON.stringify([accounts.map(({id,email,sentFolderOverride})=>({id,email,sentFolderOverride})),aliases]);
  const lastAccountSignature=useRef(accountSignature);
  useEffect(()=>{
    if(lastAccountSignature.current!==accountSignature){lastAccountSignature.current=accountSignature;void useInsightsStore.getState().refresh();}
  },[accountSignature]);
  const {tab,query,preferences,status,result,coverage,progress,selection}=state;
  const [dates,setDates]=useState({startDate:query.startDate,endDate:query.endDate});
  const [dateError,setDateError]=useState(false);
  const returnFocus=useRef(null), page=useRef(null), tabs=useRef(null);
  useEffect(()=>{setDates({startDate:query.startDate,endDate:query.endDate});},[query.startDate,query.endDate]);
  useEffect(()=>{page.current?.focus();},[]);
  const busy=status==='loading'||status==='querying';
  const select=selection=>{returnFocus.current=document.activeElement;void state.loadMessages(selection);};
  const closeMessages=()=>{cancelInsightsSelection();state.closeMessages();requestAnimationFrame(()=>returnFocus.current?.isConnected && returnFocus.current.focus());};
  const applyDates=()=>{
    if(!dates.startDate || !dates.endDate || dates.startDate>dates.endDate){setDateError(true);return;}
    setDateError(false);void state.setQuery({range:'custom',...dates});
  };
  const switchTab=(event)=>{
    const buttons=[...tabs.current.querySelectorAll('[role="tab"]')],index=buttons.indexOf(event.target);
    const delta=event.key==='ArrowRight'?1:event.key==='ArrowLeft'?-1:0;
    if(!delta && !['Home','End'].includes(event.key))return;
    event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+delta+buttons.length)%buttons.length;
    buttons[next].focus();buttons[next].click();
  };
  const total=result ? result.totals[query.direction] ?? result.totals.both : 0;
  return <section ref={page} tabIndex={-1} className="insights-page" data-testid="insights-page" data-status={status}
    aria-label={t('insights.title')} onKeyDown={e=>{
      if(e.key!=='Escape')return;
      e.preventDefault();e.stopPropagation();
      if(state.detailOpen){cancelInsightsSelection();state.setDetailOpen(false);}else if(selection)closeMessages();else onClose();
    }}>
    <header className="insights-header">
      <div className="insights-heading"><Button variant="ghost" icon size="sm" onClick={onClose} data-testid="insights-close" title={t('insights.back')}><ArrowLeft size={18}/></Button>
        <h1>{t('insights.title')}</h1></div>
      <Button variant="secondary" size="sm" onClick={()=>state.refresh()} loading={status==='loading'} data-testid="insights-refresh" title={t('insights.refresh')}><RefreshCw size={14}/>{t('insights.refresh')}</Button>
    </header>
    <div className="insights-scroll">
      <div className="insights-toolbar">
        <label><span>{t('insights.accounts')}</span><select data-testid="insights-accounts" value={preferences.accountIds?.length===1?preferences.accountIds[0]:''}
          onChange={e=>state.setQuery({accountIds:e.target.value?[e.target.value]:null})}>
          <option value="">{t('insights.allAccounts')}</option>{accounts.map(a=><option key={a.id} value={a.id}>{a.email}</option>)}</select></label>
        <label><span>{t('insights.range')}</span><select data-testid="insights-range-preset" value={preferences.range || '12m'} onChange={e=>state.setQuery({range:e.target.value,...(e.target.value==='custom'?{startDate:query.startDate,endDate:query.endDate}:{})})}>
          <option value="30d">{t('insights.range30')}</option><option value="90d">{t('insights.range90')}</option><option value="12m">{t('insights.rangeYear')}</option><option value="custom">{t('insights.custom')}</option>
        </select></label>
        <label><span>{t('insights.direction')}</span><select data-testid="insights-direction" value={query.direction || 'received'} onChange={e=>state.setQuery({direction:e.target.value})}>
          <option value="received">{t('insights.chart.received')}</option><option value="sent">{t('insights.chart.sent')}</option><option value="both">{t('insights.both')}</option>
        </select></label>
        <label className="insights-checkbox"><input data-testid="insights-hide-automated" type="checkbox" checked={query.hideAutomated || false} onChange={e=>state.setQuery({hideAutomated:e.target.checked})}/><span>{t('insights.hideAutomated')}</span></label>
      </div>
      {preferences.range==='custom' && <div className="insights-dates">
        <label><span>{t('insights.start')}</span><input type="date" data-testid="insights-start-date" value={dates.startDate || ''} onChange={e=>setDates({...dates,startDate:e.target.value})} onKeyDown={e=>e.key==='Enter'&&applyDates()}/></label>
        <label><span>{t('insights.end')}</span><input type="date" data-testid="insights-end-date" value={dates.endDate || ''} onChange={e=>setDates({...dates,endDate:e.target.value})} onKeyDown={e=>e.key==='Enter'&&applyDates()}/></label>
        <Button size="sm" data-testid="insights-apply-range" onClick={applyDates}>{t('insights.applyDates')}</Button>
        {dateError && <p role="alert">{t('insights.invalidDates')}</p>}
      </div>}
      <div className="insights-summary" aria-live="polite">
        {result && <><strong data-testid="insights-total">{t('insights.total',{count:total})}</strong><p data-testid="insights-counts">{t('insights.counts',{received:result.totals.received,sent:result.totals.sent})}</p></>}
        {busy && <p role="status">{status==='loading'?t('insights.loading',{count:progress?.loaded || 0}):t('insights.querying')}</p>}
      </div>
      <div className="insights-coverage" data-testid="insights-coverage">
        <p>{t('insights.coverage')}</p>
        {coverage?.status==='partial' && <p>{t('insights.partial')}</p>}
        {coverage?.status==='stale' && <p>{t('insights.stale')}</p>}
        <details><summary>{t('insights.coverageDetails')}</summary><p>{t('insights.serverUnknown')}</p>
          {coverage?.updatedAt && <p>{t('insights.updated',{date:new Date(coverage.updatedAt).toLocaleString(locale())})}</p>}
          {coverage?.folders?.map((folder,i)=><p key={`${folder.accountId}:${folder.mailbox}:${i}`}><b>{accounts.find(a=>a.id===folder.accountId)?.email} · {folder.mailbox}</b><br/>{t('insights.coverageFolder',{cached:folder.cachedHeaders,known:folder.knownServerMessages ?? t('insights.unknown')})}</p>)}
        </details>
        {result?.unknownDateCount>0 && <Button variant="link" size="xs" disabled={status!=='ready'} onClick={()=>select({startDate:null,endDate:null})}>{t('insights.unknownDates',{count:result.unknownDateCount})}</Button>}
        {result?.fallbackDateCount>0 && <p>{t('insights.fallbackDates',{count:result.fallbackDateCount})}</p>}
        {result?.uncertainIdentityCount>0 && <p>{t('insights.uncertainIdentity',{count:result.uncertainIdentityCount})}</p>}
      </div>
      {status==='error' && <p role="alert" className="insights-error">{t('insights.failed')}</p>}
      <div className="insights-tabs" role="tablist" ref={tabs} aria-label={t('insights.views')} onKeyDown={switchTab}>
        {['map','timeline','activity'].map(id=><button type="button" role="tab" id={`insights-tab-${id}`} aria-controls={`insights-panel-${id}`} aria-selected={tab===id} tabIndex={tab===id?0:-1} key={id} data-testid={`insights-tab-${id}`} onClick={()=>state.setTab(id)}>{t(`insights.${id}`)}</button>)}
      </div>
      {query.senderAddress && <Button variant="subtle" size="sm" onClick={()=>state.selectSender(null)} data-testid="insights-clear-sender" title={t('insights.clearSender')}>{query.senderAddress}<X size={14}/>{t('insights.clearSender')}</Button>}
      <div role="tabpanel" id={`insights-panel-${tab}`} aria-labelledby={`insights-tab-${tab}`} className="insights-content" aria-busy={busy} inert={status!=='ready'?'':undefined}>
        {result && <>
          {tab==='map' && <SenderMap senders={result.senders} endAt={`${query.endDate}T23:59:59`} selectedAddress={query.senderAddress} onSelect={async address=>{returnFocus.current=document.activeElement;await state.selectSender(address);const current=useInsightsStore.getState();if(current.isOpen && current.query.senderAddress===address && current.status==='ready')await current.loadMessages({senderAddress:address});}}/>}
          {tab==='timeline' && <SenderTimeline lanes={result.lanes} query={query} onQueryChange={state.setQuery} onSelectBucket={select}/>}
          {tab==='activity' && <><ActivityCalendar days={result.days} direction={query.direction} selectedDate={state.selectedDay} onSelectDate={date=>{returnFocus.current=document.activeElement;void state.selectDay(date);}}/>{query.direction==='both'&&<p className="insights-note">{t('insights.selfMail')}</p>}</>}
        </>}
        {status==='ready' && !total && <div className="insights-empty"><h2>{t('insights.noMail')}</h2><p>{accounts.length?t('insights.noMailHint'):t('insights.noAccounts')}</p></div>}
      </div>
      {selection && <InsightsMessages key={JSON.stringify(selection)} messages={state.messages} loading={state.messagesLoading} detailOpen={state.detailOpen}
        onOpenMessage={openInsightsMessage} onDetailChange={state.setDetailOpen} onCancel={cancelInsightsSelection}
        onClose={closeMessages} onCloseReader={()=>{cancelInsightsSelection();state.setDetailOpen(false);}} onComposeReply={onComposeReply}/>}
    </div>
  </section>;
}
