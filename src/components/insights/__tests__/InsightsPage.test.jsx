// @vitest-environment jsdom
import React from 'react';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,cleanup,act,within} from '@testing-library/react';
import InsightsPage from '../InsightsPage';
import {useInsightsStore} from '../../../stores/insightsStore';
import {useMailStore} from '../../../stores/mailStore';
import {t} from '../../../i18n';
const actions={setTab:vi.fn(),setQuery:vi.fn(),refresh:vi.fn(),selectDay:vi.fn(),loadMessages:vi.fn()};
beforeEach(()=>{
  useMailStore.setState({accounts:[{id:'a',email:'me@example.test'}]});
  useInsightsStore.setState({isOpen:true,tab:'activity',status:'ready',query:{startDate:'2026-09-01',endDate:'2026-09-09',accountIds:['a'],direction:'received',timeZone:'UTC'},preferences:{range:'custom'},progress:null,selection:null,messages:[],error:null,
    coverage:{status:'partial',folders:[{accountId:'a',mailbox:'INBOX',cachedHeaders:2,knownServerMessages:700,missingHeaders:698}]},
    result:{totals:{received:2,sent:1,both:3},days:[{date:'2026-09-01',received:2,sent:1,value:2}],senders:[],lanes:[],unknownDateCount:1,fallbackDateCount:0,uncertainIdentityCount:0},...actions});
  Object.values(actions).forEach(fn=>fn.mockClear());
});
afterEach(cleanup);
it('shows local coverage and distinct received/sent totals with unknown-date access',()=>{
  render(<InsightsPage onClose={()=>{}}/>);
  expect(screen.getByText(t('insights.coverage'))).toBeTruthy();expect(screen.getByText(t('insights.partial'))).toBeTruthy();
  expect(screen.getByTestId('insights-counts').textContent).toBe(t('insights.counts',{received:2,sent:1}));
  fireEvent.click(screen.getByRole('button',{name:t('insights.unknownDates',{count:1})}));
  expect(actions.loadMessages).toHaveBeenCalledWith({startDate:null,endDate:null});
});
it('limits the account filter to real single-account choices',()=>{
  render(<InsightsPage onClose={()=>{}}/>);
  const filter=screen.getByTestId('insights-accounts');
  expect(within(filter).queryByRole('option',{name:t('insights.allAccounts')})).toBeNull();
  expect(filter.value).toBe('a');
  expect([...filter.options].map(option=>option.value)).toEqual(['a']);
});
it('shares direction and account filters across real tabs',()=>{
  render(<InsightsPage onClose={()=>{}}/>);
  fireEvent.change(screen.getByLabelText(t('insights.direction')),{target:{value:'sent'}});
  expect(actions.setQuery).toHaveBeenCalledWith({direction:'sent'});
  fireEvent.click(screen.getByRole('tab',{name:t('insights.timeline')}));expect(actions.setTab).toHaveBeenCalledWith('timeline');
  expect(screen.getByRole('tab',{name:t('insights.activity')}).getAttribute('aria-selected')).toBe('true');
});
it('returns through the visible back control and provides retry after an error',()=>{
  const close=vi.fn();useInsightsStore.setState({status:'error',error:'unreadable file',coverage:{status:'stale'}});
  render(<InsightsPage onClose={close}/>);fireEvent.click(screen.getByRole('button',{name:t('insights.back')}));expect(close).toHaveBeenCalledOnce();
  expect(screen.getByText(t('insights.stale'))).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:t('insights.refresh')}));expect(actions.refresh).toHaveBeenCalledOnce();
});
it('does not present a failed scan as an empty successful view',()=>{
  useInsightsStore.setState({status:'error',result:null,error:'vault unavailable'});render(<InsightsPage onClose={()=>{}}/>);
  expect(screen.queryByText(t('insights.noMail'))).toBeNull();expect(screen.getByRole('alert')).toBeTruthy();
});

it('makes the previous chart inert while updating its data',()=>{
 useInsightsStore.setState({status:'querying'});render(<InsightsPage onClose={()=>{}}/>);
 expect(screen.getByRole('tabpanel').hasAttribute('inert')).toBe(true);
});
it('dismisses a sender tooltip on Escape without closing Insights',()=>{
  const close=vi.fn();
  useInsightsStore.setState({tab:'map',result:{...useInsightsStore.getState().result,senders:[{address:'ana@test',name:'Ana',count:4,received:3,sent:1,lastAt:'2026-09-08T12:00:00Z',automationEvidence:[]}]}});
  render(<InsightsPage onClose={close}/>);
  const node=within(screen.getByRole('group',{name:'Sender map'})).getByRole('button',{name:/Ana.*ana@test/});
  fireEvent.pointerOver(node,{clientX:100,clientY:120});
  expect(screen.getByRole('tooltip')).toBeTruthy();
  fireEvent.keyDown(node,{key:'Escape'});
  expect(screen.queryByRole('tooltip')).toBeNull();
  expect(screen.getByTestId('insights-page')).toBeTruthy();
  expect(close).not.toHaveBeenCalled();
});


it('refreshes local inventory when a configured account disappears',()=>{
 render(<InsightsPage onClose={()=>{}}/>);
 act(()=>useMailStore.setState({accounts:[]}));expect(actions.refresh).toHaveBeenCalledOnce();
});

it('does not reopen an older sender after a newer sender query finishes',async()=>{
 let finishA;const a=new Promise(resolve=>{finishA=resolve;});
 const senders=[{address:'a@example.test',name:'Ana',count:1,lastAt:'2026-09-08T12:00:00Z'},{address:'b@example.test',name:'Ben',count:1,lastAt:'2026-09-09T12:00:00Z'}];
 useInsightsStore.setState({tab:'map',result:{...useInsightsStore.getState().result,senders},selectSender:address=>{
   useInsightsStore.setState({query:{...useInsightsStore.getState().query,senderAddress:address}});return address==='a@example.test'?a:Promise.resolve();
 }});
 render(<InsightsPage onClose={()=>{}}/>);
 fireEvent.click(screen.getAllByRole('button',{name:/Ana, a@example.test/})[0]);
 await act(async()=>fireEvent.click(screen.getAllByRole('button',{name:/Ben, b@example.test/})[0]));
 await act(async()=>finishA());
 expect(actions.loadMessages).toHaveBeenCalledTimes(1);expect(actions.loadMessages).toHaveBeenCalledWith({senderAddress:'b@example.test'});
});
