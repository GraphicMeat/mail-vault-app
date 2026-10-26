import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createDemoBackend } from '../../src/demo/backend.js';
const RPCS = ['accounts.list','accounts.get','accounts.put','accounts.remove','accounts.reorder','accounts.replace_all'];
const read = path => readFileSync(path, 'utf8');

describe('staged native account capability', () => {
  it.each(RPCS)('%s is registered in transport and core', rpc => {
    const transport = read('src/services/transport.js');
    const start = transport.indexOf('export const DAEMON_OWNED');
    expect(transport.slice(start, transport.indexOf(']);', start))).toContain(`'${rpc}'`);
    expect(read('src-core/src/accounts_doc.rs')).toContain(`"${rpc}"`);
  });
  it.each(['de','en','es','fr','it','ja','ko','pt-BR','zh-Hans'])('%s supplies neutral account error keys', locale => {
    const catalog = JSON.parse(read(`src/i18n/locales/${locale}.json`));
    for (const key of ['errors.accountsConflict','errors.accountsInvalid','errors.accountsWriteFailed']) expect(catalog[key]).toBeTypeOf('string');
    if (locale === 'en') expect(catalog['errors.accountsWriteFailed']).not.toMatch(/unchanged|nothing was saved/i);
  });
  it('demo routes all six names, strips incoming secrets, persists and resets list without credentials writes', async () => {
    const demo = createDemoBackend();
    const call = (method, params = {}) => demo.invoke('daemon_rpc', { method, params });
    const credentials = await demo.invoke('credentials.get');
    const initial = (await call('accounts.list')).accounts;
    await call('accounts.put', { entry: { id:'new', password:'incoming', oauth2AccessToken:'incoming', oauth2RefreshToken:'incoming' } });
    expect((await call('accounts.get', { id:'new' })).account).toEqual({ id:'new' });
    const restored = createDemoBackend(); restored.restoreState(demo.exportState());
    expect((await restored.invoke('accounts.list')).accounts).toContainEqual({ id:'new' });
    await call('accounts.reorder', { ids:['new'] });
    expect((await call('accounts.list')).accounts[0].id).toBe('new');
    await call('accounts.remove', { id:'new' });
    expect((await call('accounts.get', { id:'new' })).account).toBeNull();
    await call('accounts.replace_all', { entries:[{id:'only', password:'incoming'}] });
    expect((await call('accounts.list')).accounts).toEqual([{id:'only'}]);
    expect(await demo.invoke('credentials.get')).toEqual(credentials);
    demo.reset(); expect((await call('accounts.list')).accounts).toEqual(initial);
  });
  it('demo refuses native add/update without changing metadata or credentials', async () => {
    const demo=createDemoBackend();const before=await demo.invoke('accounts.list');const credentials=await demo.invoke('credentials.get');
    for(const method of ['accounts.add','accounts.update']) await expect(demo.invoke(method,{account:{id:'synthetic',password:'synthetic-secret'}})).rejects.toThrow('errors.daemonOutdated');
    expect(await demo.invoke('accounts.list')).toEqual(before);expect(await demo.invoke('credentials.get')).toEqual(credentials);
  });

});
