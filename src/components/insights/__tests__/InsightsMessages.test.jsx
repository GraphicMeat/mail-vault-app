// @vitest-environment jsdom
import React from 'react';
import {afterEach,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,cleanup,waitFor} from '@testing-library/react';
import InsightsMessages from '../InsightsMessages';
import {t} from '../../../i18n';
vi.mock('../../EmailViewer',()=>({EmailViewer:()=> <div data-testid="owned-reader">Reader</div>}));
afterEach(cleanup);
const match={key:'logical:received',subject:'Delivery dates',from:{name:'Ana',address:'ana@example.test'},eventAt:'2026-09-09T12:00:00Z',copies:[{accountId:'b',mailbox:'Projects/North',uid:7,source:'server-cache',messageId:'<one>'}]};
it('opens the actual match carrying every physical locator, never the active mailbox UID',async()=>{
 const open=vi.fn().mockResolvedValue(true), detail=vi.fn();render(<InsightsMessages messages={[match]} onOpenMessage={open} onDetailChange={detail} onClose={()=>{}}/>);
 fireEvent.click(screen.getByRole('button',{name:/Delivery dates/}));await waitFor(()=>expect(open).toHaveBeenCalledWith(match));
 expect(detail).toHaveBeenCalledWith(true);expect(screen.getByTestId('insights-match').dataset.mailbox).toBe('Projects/North');
});
it('bounds the rendered rows and exposes later matches when scrolled',()=>{
 const messages=Array.from({length:120},(_,i)=>({...match,key:String(i),subject:`Letter ${i}`}));render(<InsightsMessages messages={messages} onClose={()=>{}}/>);
 expect(screen.getAllByTestId('insights-match').length).toBeLessThan(120);
 fireEvent.scroll(screen.getByTestId('insights-message-list'),{target:{scrollTop:7200}});expect(screen.getByRole('button',{name:/Letter 110/})).toBeTruthy();expect(screen.getAllByTestId('insights-match').length).toBeLessThan(30);
});
it('owns only one reader when a detail is open and closes through its control',()=>{
 const closeReader=vi.fn();render(<InsightsMessages messages={[match]} detailOpen onCloseReader={closeReader} onClose={()=>{}}/>);
 expect(screen.getAllByTestId('owned-reader')).toHaveLength(1);fireEvent.click(screen.getByRole('button',{name:t('insights.closeReader')}));expect(closeReader).toHaveBeenCalledOnce();
});
it('keeps failed message opens visible as errors and avoids a success state',async()=>{
 const detail=vi.fn();render(<InsightsMessages messages={[match]} onOpenMessage={async()=>{throw new Error('gone')}} onDetailChange={detail} onClose={()=>{}}/>);
 fireEvent.click(screen.getByRole('button',{name:/Delivery dates/}));await waitFor(()=>expect(screen.getByRole('alert')).toBeTruthy());expect(detail).toHaveBeenLastCalledWith(false);
});

it('returns focus to the current message row when its detail closes',()=>{
 function Harness(){const [detail,setDetail]=React.useState(true);return <InsightsMessages messages={[match]} detailOpen={detail} onCloseReader={()=>setDetail(false)} onClose={()=>{}}/>;}
 render(<Harness/>);const close=screen.getByRole('button',{name:t('insights.closeReader')});close.focus();fireEvent.click(close);
 expect(document.activeElement).toBe(screen.getByTestId('insights-match'));
});

it('invalidates its completion on unmount without canceling a newly restored external reader',async()=>{
 let finish;const open=vi.fn(()=>new Promise(resolve=>{finish=resolve;})),cancel=vi.fn(),detail=vi.fn();
 const {unmount}=render(<InsightsMessages messages={[match]} onOpenMessage={open} onDetailChange={detail} onCancel={cancel} onClose={()=>{}}/>);
 fireEvent.click(screen.getByTestId('insights-match'));unmount();finish(true);await Promise.resolve();
 expect(cancel).not.toHaveBeenCalled();expect(detail).not.toHaveBeenCalledWith(true);
});
