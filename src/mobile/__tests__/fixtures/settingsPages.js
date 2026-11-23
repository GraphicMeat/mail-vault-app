// Every page and section the phone's Settings shows (src/mobile/Settings.jsx): the manifest's
// pages and sections the phone has (MOBILE_PAGES true), the pages with no search entries (Help),
// and the desktop-notice pages. `openPage(render, Settings, t, page)` mounts Settings on one, its
// section's tab picked, and waits for its engine replies. For the tests that walk every page.
import React from 'react';
import { act, fireEvent } from '@testing-library/react';
import { settingSearchGroups, MOBILE_PAGES, DESKTOP_NOTICE, settingText } from '../../../components/settings/settingsManifest';

export function phonePages() {
  const pages = [];
  const add = (page) => { if (!pages.some((p) => p.name === page.name)) pages.push(page); };
  for (const g of settingSearchGroups) {
    if (MOBILE_PAGES[g.id] !== true || (g.section && !g.sectionKey)) continue;
    add({ id: g.id, sectionKey: g.sectionKey, name: `${g.id}${g.section ? ` > ${g.section}` : ''}` });
  }
  for (const [id, decision] of Object.entries(MOBILE_PAGES)) {
    if (decision === true || decision === DESKTOP_NOTICE) add({ id, name: id, notice: decision === DESKTOP_NOTICE });
  }
  return pages;
}

export const settle = () => act(async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0)); });

export async function openPage(render, Settings, t, page) {
  const view = render(React.createElement(Settings, { onClose: () => {}, page: page.id }));
  await settle();
  if (page.sectionKey) {
    const tab = [...view.container.querySelectorAll('[role="tab"]')].find((el) => settingText(el.textContent) === settingText(t(page.sectionKey)));
    if (tab && tab.getAttribute('aria-selected') !== 'true') {
      fireEvent.click(tab);
      await settle();
    }
  }
  return view;
}
