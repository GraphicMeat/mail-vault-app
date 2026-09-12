/* Rich, entirely fictional mail used by the browser demo. Keeping this data
 * separate from the command adapter makes the native simulation easier to
 * audit while still exercising the real list, thread, HTML, and MIME paths. */

const safeDate = (sessionNow, bucket, hours = 0) => {
  const current = new Date(sessionNow);
  const month = bucket % 12;
  let year = current.getUTCFullYear() - Math.floor(bucket / 12);
  let day = 4 + ((bucket * 5) % 22);
  if (year === current.getUTCFullYear() && month >= current.getUTCMonth()) year -= 1;
  if (year === current.getUTCFullYear() && month === current.getUTCMonth() && day >= current.getUTCDate()) year -= 1;
  const timestamp = Date.UTC(year, month, day, 8 + (bucket % 4), 30, 0) + hours * 3600000;
  return new Date(Math.min(timestamp, sessionNow - 1000)).toISOString();
};

const participant = (name, address) => ({ name, address });

const THREAD_FOLLOWUPS = {
  'brand-refresh': [
    'I will put the two colour studies beside the menu mockup so the decision is judged in context.',
    'The next review only needs one open question: where the seasonal accent appears when the mark is small.',
    'I noted the rationale in the handoff so a future editor can change the system without guessing.',
    'Once the guide is approved, the same rules can travel from the menu to the packaging and the website.',
  ],
  'weekend-table': [
    'I wrote the timing in the shared note and left a little space between each stop instead of turning the day into a checklist.',
    'The bookshop closes later than we thought, so we can linger if the market is crowded.',
    'That gives us a useful fallback without changing the part of the plan we are both looking forward to.',
    'I will send the final address in the morning, after checking whether the ferry timetable has changed.',
  ],
  'quarterly-close': [
    'I kept the original export beside the corrected view so the reason for the adjustment remains easy to audit.',
    'The note now names the late payment and its settlement date, which should answer the only question raised last quarter.',
    'I am leaving the working record untouched until the accountant has signed off on the explanation.',
    'After approval, the archive can be closed while the concise totals stay available to the finance team.',
  ],
  'studio-wayfinding': [
    'I measured the sightline from the entrance and the smallest label still reads comfortably before the first turn.',
    'The example card will show the system at visitor distance, where the hierarchy matters more than the close-up mockup.',
    'I also noted which surfaces can be replaced later so maintenance does not require a new sign system.',
    'The building manager can now approve the placement without needing the entire interior deck.',
  ],
  'coastal-trip': [
    'I put the route, ferry times, and bakery address in one note so we can check it from the platform.',
    'The gallery is close enough to the market that the wet-weather plan still feels like a day out rather than a compromise.',
    'I am keeping the schedule loose around lunch because the best part of the trip will probably be the unplanned stop.',
    'The final note will include the station entrance and the return train, then we can forget about logistics.',
  ],
  'vendor-renewal': [
    'The account history now explains why the forwarding rule was removed, which will help the next reviewer trust the change.',
    'I checked the export at normal print size so the security note does not disappear into a footnote.',
    'The renewal window and reviewer date are separate fields now, making the next reminder unambiguous.',
    'With the signed copy stored beside the account notice, the next review can begin from a complete record.',
  ],
};

const THREADS = [
  {
    id: 'brand-refresh', account: 0, bucket: 4, participant: participant('Nell Okafor', 'nell@smokehouse.design'),
    messages: [
      ['Brand refresh — what should stay?', 'I pulled the current marks into one board. The strongest direction keeps the hand-drawn edge but gives the wordmark more room.'],
      ['Re: Brand refresh — what should stay?', 'That feels right. I am attached to the old red, though; could we test it beside the warmer saffron before we decide?'],
      ['Brand refresh — two colour studies', 'I made both studies and added a neutral paper background. The red is lively, while saffron makes the food photography calmer.'],
      ['Re: Brand refresh — two colour studies', 'Saffron wins on the menu and the packaging. Keep the red as a small seasonal accent so the old identity still has a place.'],
      ['Brand refresh — type pairing', 'The display face needs a quieter text partner. I tried Brisket Sans with a neutral grotesk and the hierarchy finally feels effortless.'],
      ['Re: Brand refresh — type pairing', 'I agree with the grotesk. Please keep the numerals tabular in the pricing block; the last review caught a distracting jump.'],
      ['Brand refresh — client review notes', 'The client liked the warmer system and asked for a single page explaining when the red accent appears. I drafted that page.'],
      ['Re: Brand refresh — client review notes', 'The explanation is clear. Add one real menu example and we can send the review deck without another call.'],
      ['Brand refresh — final direction', 'The deck is approved for Friday. I have marked the red accent as seasonal and attached the one-page usage guide.'],
      ['Re: Brand refresh — final direction', 'Wonderful. I will package the source files and send the final handoff after lunch.'],
    ],
  },
  {
    id: 'weekend-table', account: 1, bucket: 17, participant: participant('Ida Marsh', 'ida.marsh@fastmail.example'),
    messages: [
      ['A Saturday plan with a little room', 'I found a walk that starts by the river and ends near the market. We can decide on dinner once we see the weather.'],
      ['Re: A Saturday plan with a little room', 'I like the loose plan. Book the small table at Brine & Board if the forecast stays dry, and I will bring the camera.'],
      ['The river route is marked', 'The route is shorter than I remembered, so there is time for the bookshop too. I dropped the map pin in our notes.'],
      ['Re: The river route is marked', 'Perfect. I have moved the booking later by half an hour so we do not have to rush from the bookshop.'],
      ['A change of coat and a better forecast', 'The rain has moved to Sunday. I am bringing the blue coat and the little film camera we found in the cupboard.'],
      ['Re: A change of coat and a better forecast', 'That camera deserves an outing. I will bring the spare battery and meet you under the old clock at ten.'],
      ['Saturday receipts and route notes', 'The market stall had the paper we wanted. I attached the receipt and route notes with the meeting point and café booking.'],
      ['Re: Saturday receipts and route notes', 'The route notes are clear. I will meet under the old clock and keep the market stop before lunch.'],
      ['Next walk: hill or harbour?', 'The harbour route has a new café, while the hill has the view. I vote harbour if we want another quiet afternoon.'],
      ['Re: Next walk: hill or harbour?', 'Harbour it is. I will check the opening time and send a note before the week gets busy.'],
    ],
  },
  {
    id: 'quarterly-close', account: 2, bucket: 30, participant: participant('Dario Vella', 'dario@rackandrind.com'),
    messages: [
      ['Quarterly close — first pass', 'The figures are nearly reconciled. I still need the August hosting receipt and confirmation that the licence seats did not change.'],
      ['Re: Quarterly close — first pass', 'The seat count is unchanged. I am sending the hosting receipt now and will flag the one payment that landed two days late.'],
      ['Quarterly close — receipt matched', 'The receipt matches the ledger. I moved the late payment into the correct month so the cash view no longer looks artificially low.'],
      ['Re: Quarterly close — receipt matched', 'Thank you. The corrected view agrees with our bank export. Can we keep the old statement attached for the audit trail?'],
      ['Quarterly close — statement archive', 'Yes, the old statement stays in the archive. I added a note linking it to the corrected payment and marked the duplicate for review.'],
      ['Re: Quarterly close — statement archive', 'That is exactly the trail our accountant asked for. Please also record the date the duplicate was found.'],
      ['Quarterly close — duplicate resolved', 'The duplicate was found on the 14th and removed from the working view. The archived copy remains available for reference.'],
      ['Re: Quarterly close — duplicate resolved', 'The working view now ties out. I will ask the accountant to review the note before we close the quarter.'],
      ['Quarterly close — ready for review', 'I attached the review summary with three totals: billed, received, and carried forward. Nothing else is outstanding.'],
      ['Re: Quarterly close — ready for review', 'Received. I have sent the summary to the accountant and will come back only if they find a question.'],
    ],
  },
  {
    id: 'studio-wayfinding', account: 0, bucket: 43, participant: participant('Mara Cole', 'mara@northstar.example'),
    messages: [
      ['Studio wayfinding — the first sketch', 'The entrance needs one clear welcome point. I mapped the sign, coat hooks, and project shelf before touching the wall colours.'],
      ['Re: Studio wayfinding — the first sketch', 'The project shelf is a good anchor. Could the welcome point include the weekly board so visitors know who is in?'],
      ['Studio wayfinding — board options', 'I tried a magnetic board and a framed print. The magnetic board wins because it can change without making the wall feel busy.'],
      ['Re: Studio wayfinding — board options', 'Keep the magnetic board. Put the emergency details on a smaller card beside it so the useful information does not compete.'],
      ['Studio wayfinding — type size check', 'At the far end of the room, the 18 point labels are readable and the 14 point notes are not. I adjusted the system to two sizes.'],
      ['Re: Studio wayfinding — type size check', 'Two sizes should make the handoff easier. Add one example card to the review so people can judge it at a glance.'],
      ['Studio wayfinding — material samples', 'The birch sample is warm but marks easily. The powder-coated steel is more durable and still sits quietly beside the paper goods.'],
      ['Re: Studio wayfinding — material samples', 'Steel is the sensible choice. Use the birch only for the small welcome shelf where the texture can be touched.'],
      ['Studio wayfinding — review tomorrow', 'The room plan, type sizes, and material notes are in the deck. I will bring a full-size label to tomorrow’s review.'],
      ['Re: Studio wayfinding — review tomorrow', 'Good. I have invited the building manager and will bring tape so we can test the label on the actual wall.'],
    ],
  },
  {
    id: 'coastal-trip', account: 1, bucket: 56, participant: participant('Ida Marsh', 'ida.marsh@fastmail.example'),
    messages: [
      ['Coastal trip — three possible trains', 'The early train is quietest, the middle train is cheapest, and the late train arrives just before sunset.'],
      ['Re: Coastal trip — three possible trains', 'Let us take the middle train and spend the difference on the harbour room. I would rather arrive with daylight.'],
      ['Coastal trip — room confirmed', 'The harbour room is held for two nights. The host left a note about the bakery that opens before the first ferry.'],
      ['Re: Coastal trip — room confirmed', 'That sounds ideal. I will pack the small notebook and leave enough space for the local map.'],
      ['Coastal trip — weather and a spare plan', 'The forecast is bright on Saturday and unsettled on Sunday. I found a gallery and a covered market for the wet afternoon.'],
      ['Re: Coastal trip — weather and a spare plan', 'Keep both. The covered market has the ceramics stall I wanted to see, so rain would not ruin the day.'],
      ['Coastal trip — ferry times checked', 'The first ferry leaves at 08:20 and the return is flexible. I saved the timetable offline for the walk back.'],
      ['Re: Coastal trip — ferry times checked', 'Thank you. I will set an alarm for seven and bring breakfast from the station.'],
      ['Coastal trip — packing list', 'Notebook, camera, light coat, and the red scarf. I have left room for anything we find at the market.'],
      ['Re: Coastal trip — packing list', 'The red scarf is essential. I will send the final train details the night before.'],
    ],
  },
  {
    id: 'vendor-renewal', account: 2, bucket: 69, participant: participant('Studio Bank', 'notices@studiobank.example'),
    messages: [
      ['Vendor renewal — account review', 'The annual vendor review is open. We need the current billing contact and confirmation of the renewal window.'],
      ['Re: Vendor renewal — account review', 'The billing contact is Studio Accounts and the renewal window should stay in September. Please keep the account notice attached.'],
      ['Vendor renewal — contact confirmed', 'The contact is updated. I also checked the secondary notice address and removed an old forwarding rule.'],
      ['Re: Vendor renewal — contact confirmed', 'That is helpful. The old forwarding rule was still visible in our records even though it had stopped receiving mail.'],
      ['Vendor renewal — security note', 'The account now requires a second reviewer for changes. I added the review date to the internal record.'],
      ['Re: Vendor renewal — security note', 'Second review is fine. Please make the reviewer field readable in the exported summary.'],
      ['Vendor renewal — summary format', 'The summary now separates contact, renewal, and security details. It should print cleanly on one page.'],
      ['Re: Vendor renewal — summary format', 'One page is perfect. I will check the printed copy against the portal before signing off.'],
      ['Vendor renewal — ready to sign', 'The portal and printed copy match. I attached the signed summary and noted the next review date.'],
      ['Re: Vendor renewal — ready to sign', 'Signed copy received. The renewal can proceed, and the next review is on the calendar.'],
    ],
  },
];

const NEWSLETTERS = [
  ['Northstar Review', '#d97745', 'The editorial/design digest', 'Five small decisions that made a quiet interface feel more confident', ['A margin is a decision', 'One strong image beats three almost-right ones', 'Let the footer finish the story']],
  ['Signal & Type', '#5e6ad2', 'Release notes for thoughtful teams', 'Version 4.8: clearer states, faster handoffs, fewer surprises', ['State names people can understand', 'The new keyboard map', 'A calmer migration checklist']],
  ['Harbour Table', '#16857a', 'Travel and food from the coast', 'A two-day route through bakeries, ferry decks, and one excellent soup', ['Morning at the fish market', 'The covered market route', 'A room above the harbour']],
  ['Ledger Light', '#b7791f', 'A practical financial digest', 'What changed in the quarter, where the numbers settled, and what to review next', ['Billed versus received', 'Three useful questions for close', 'Keep the old statement']],
  ['Field Notes Club', '#386641', 'A monthly letter for makers', 'Tools, materials, and patient ways to get from first sketch to finished work', ['The paper test', 'A better project shelf', 'One hour for the final pass']],
  ['Cinder Press', '#b83280', 'Stories from independent studios', 'Inside the teams making identity systems that can live in the real world', ['The mark at postage size', 'When a palette earns its place', 'The handoff people actually use']],
  ['Clear Weather', '#2563eb', 'A weekend itinerary', 'The early train, the long walk, and a weather-proof afternoon', ['Take the middle train', 'Find the covered route', 'Leave room in the bag']],
  ['Common Room', '#7c3aed', 'A letter about shared spaces', 'How small signs and generous shelves help a room welcome people', ['The first thing visitors see', 'Two sizes of type', 'Materials that age well']],
  ['Paper & Proof', '#be5b3d', 'Print craft in your inbox', 'A short guide to stock, crop marks, and the proof that earns approval', ['Choose stock by touch', 'Keep crop marks visible', 'Name the final proof']],
  ['The Quiet Build', '#0f766e', 'Product notes without the noise', 'A monthly look at the details behind reliable, respectful software', ['Small states matter', 'Design the recovery path', 'What we declined to automate']],
  ['Café Ledger', '#92400e', 'The seasonal table', 'Recipes, room, and a little arithmetic for a better gathering', ['The short rib again', 'Four seats by the window', 'A receipt worth keeping']],
  ['Archive Signal', '#475569', 'A considered archive letter', 'How to keep the useful record while letting the working view stay light', ['Name the record', 'Keep context nearby', 'Close the loop']],
];

const NEWSLETTER_DETAILS = [
  [
    'A wider margin gives a menu, a heading, and a photograph enough air to read as one composition. We kept the margin where the eye naturally pauses.',
    'Three food photographs became one: the one with a quiet background let the dish and the wordmark share attention instead of competing for it.',
    'The footer repeats the handoff path and the season marker, so the last line answers what to do next without adding another navigation layer.',
  ],
  [
    'The release names each state in language a support teammate can repeat. “Waiting for review” tells a person more than a spinner ever could.',
    'A small keyboard map now groups navigation beside recovery actions, keeping the shortcut list useful when the mouse is unavailable.',
    'The migration checklist starts with a preview and ends with a receipt. That order makes an irreversible step visible before it is taken.',
  ],
  [
    'Start at the fish market while the stalls are still setting out the morning catch, then take the narrow street behind the ferry office.',
    'The covered market has a ceramicist, a book table, and a soup counter. It is a proper afternoon route even when the weather turns.',
    'The harbour room is small but faces the water. Leave the window open for the evening bells and keep the morning bakery within walking distance.',
  ],
  [
    'Billed is the promise recorded on an invoice; received is the cash that actually arrived. Keeping those columns apart explains the quarter at a glance.',
    'Ask whether the late payment changed the month, whether a duplicate remains in the working view, and whether the source receipt is still attached.',
    'The old statement belongs beside the correction. It is evidence for the change, not clutter to remove once the total looks right.',
  ],
  [
    'The paper test begins with a folded corner and a pencil mark. Texture matters because a material that looks calm on screen can feel loud in a hand.',
    'A shelf earns its place when it holds the current project without becoming a display of every project that came before it.',
    'Reserve the final hour for the last pass. Small spacing corrections are easier to see after the larger decisions have stopped moving.',
  ],
  [
    'At postage size, the mark needs one legible gesture. We removed the fine detail that only appeared when the artwork was viewed very large.',
    'A palette earns its place when each colour has a job: signal, background, or emphasis. The rest can stay in the archive.',
    'The handoff names the source files, the safe edits, and the person who answers questions. That is the version a team can actually use.',
  ],
  [
    'The middle train leaves enough daylight for the harbour walk and costs less than the early service. It is the sensible centre of the weekend.',
    'For a wet afternoon, follow the covered route from the gallery to the market. The turns are short and the stalls stay open late.',
    'Pack a light coat and leave one pocket empty. The best souvenirs are usually smaller than the plan made room for.',
  ],
  [
    'Visitors first see the welcome point, so it carries the room’s promise: a clear place to arrive, pause, and learn who is working inside.',
    'Two type sizes are enough for the board. The larger label carries the destination; the smaller note carries the detail.',
    'Birch warms the shelf where hands will touch it. Powder-coated steel takes the daily knocks beside the entrance without asking for attention.',
  ],
  [
    'Choose stock by touch before comparing swatches on screen. A slight tooth can make a quiet black feel more deliberate in the hand.',
    'Keep crop marks visible through the review so everyone knows where the finished edge will land. Remove them only in the approved proof.',
    'Name the final proof with client, project, and date. A clear filename protects the decision after the meeting has faded from memory.',
  ],
  [
    'A small state such as “saved locally” tells a person where their work is before they wonder whether the button did anything.',
    'Recovery should show the next useful action and keep the original context. A calm error is a path back, not a dead end.',
    'We declined to automate the final send because a person should still see the recipient and the copy before it leaves the demo.',
  ],
  [
    'The short rib returns because it improves when prepared a day ahead. The recipe keeps the last step simple so the host can stay at the table.',
    'Four seats by the window make a better gathering than ten seats arranged for symmetry. Leave room for coats and late arrivals.',
    'Keep the receipt with the menu note. It answers what was served and gives the next season a useful starting point for the budget.',
  ],
  [
    'Name the record with the account, date, and reason it matters. A future reader should understand the file before opening it.',
    'Keep the decision beside its source note. Context is lighter to carry when it travels with the record instead of living in a separate folder.',
    'Close the loop by recording the final reviewer and date. The working view can stay small while the history remains complete.',
  ],
];

const newsletterHref = brand => brand === 'Harbour Table'
  ? 'mailto:hello@harbourtable.example?subject=Harbour%20Table%20reply'
  : '/demo/';

const NEWSLETTER_LAYOUTS = [
  ({ brand, accent, kicker, title, sections, details, href }) => `<article style="max-width:680px;margin:0 auto;font-family:Georgia,serif;color:#202124;background:#fffdf8;padding:34px"><p style="font:700 11px/1.2 -apple-system,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:${accent}">${brand}</p><h1 style="font:700 32px/1.1 Georgia,serif;margin:20px 0 10px">${title}</h1><p style="font-size:17px;line-height:1.6">${kicker}</p><hr style="border:0;border-top:2px solid ${accent};margin:28px 0">${sections.map((section, i) => `<section style="margin:24px 0"><h2 style="font-size:21px">${section}</h2><p style="line-height:1.7">${details[i]}</p>${i === 0 ? '<ul style="line-height:1.8"><li>Start with the reader\'s next question.</li><li>Make the important choice visible.</li><li>Leave a little room for change.</li></ul>' : ''}</section>`).join('')}<p style="text-align:center;margin:34px 0"><a href="${href}" style="display:inline-block;background:${accent};color:#fff;padding:13px 22px;border-radius:5px;text-decoration:none;font:600 13px -apple-system,sans-serif">Read the full note</a></p><footer style="border-top:1px solid #d8d4ca;padding-top:18px;font:12px/1.5 -apple-system,sans-serif;color:#6b665d">A fictional letter from ${brand}. No tracking pixels, subscriptions, or remote assets are used in this demo.</footer></article>`,
  ({ brand, accent, kicker, title, sections, details, href }) => `<div style="max-width:720px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#16202a;background:#f5f8fb;padding:26px"><header style="background:${accent};color:#fff;padding:26px;border-radius:12px 12px 0 0"><p style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;margin:0 0 14px">${brand}</p><h1 style="font-size:30px;line-height:1.1;margin:0">${title}</h1><p style="font-size:15px;line-height:1.5;margin-bottom:0">${kicker}</p></header><main style="background:#fff;padding:26px;border-radius:0 0 12px 12px">${sections.map((section, i) => `<section style="padding:18px 0;border-bottom:1px solid #e5eaf0"><h2 style="font-size:19px;margin:0 0 8px">${section}</h2><p style="line-height:1.65;margin:0 0 12px">${details[i]}</p>${i === 1 ? '<table style="width:100%;border-collapse:collapse;font-size:13px"><tr><th style="text-align:left;border-bottom:2px solid #dbe3ea;padding:8px">Signal</th><th style="text-align:left;border-bottom:2px solid #dbe3ea;padding:8px">What to do</th></tr><tr><td style="padding:8px;border-bottom:1px solid #e5eaf0">Clear</td><td style="padding:8px;border-bottom:1px solid #e5eaf0">Keep the path visible</td></tr><tr><td style="padding:8px">Open</td><td style="padding:8px">Leave a useful note</td></tr></table>' : ''}</section>`).join('')}<p style="margin:26px 0 6px"><a href="${href}" style="color:${accent};font-weight:700">Open this month’s field guide →</a></p></main><footer style="padding:18px 4px;font-size:12px;color:#536170">${brand} · Fictional demo edition · no remote resources</footer></div>`,
  ({ brand, accent, kicker, title, sections, details, href }) => `<div style="max-width:640px;margin:0 auto;font-family:Arial,sans-serif;color:#23303b;background:#fff;padding:30px;border:1px solid #d8e1e8"><div style="display:flex;justify-content:space-between;align-items:center;border-bottom:4px solid ${accent};padding-bottom:14px"><strong style="font-size:15px;color:${accent}">${brand}</strong><span style="font-size:11px;color:#687784">DEMO EDITION</span></div><h1 style="font-size:29px;line-height:1.12;margin:28px 0 10px">${title}</h1><p style="font-size:16px;line-height:1.6;color:#536170">${kicker}</p><div style="background:#eef5f3;padding:18px;margin:26px 0"><h2 style="margin:0 0 8px;font-size:18px;color:${accent}">In this letter</h2><ol style="line-height:1.8;margin:0;padding-left:22px">${sections.map(section => `<li>${section}</li>`).join('')}</ol></div>${sections.map((section, i) => `<h2 style="font-size:20px;margin:25px 0 7px">${section}</h2><p style="line-height:1.7">${details[i]}</p>`).join('')}<div style="text-align:center;margin:30px 0"><a href="${href}" style="background:${accent};color:#fff;padding:12px 20px;border-radius:24px;text-decoration:none;font-weight:700">Explore the sample</a></div><footer style="border-top:1px solid #d8e1e8;padding-top:16px;font-size:11px;line-height:1.5;color:#687784">You are reading a self-contained fictional newsletter. There are no live links, pixels, or remote images.</footer></div>`,
  ({ brand, accent, kicker, title, sections, details, href }) => `<div style="max-width:700px;margin:0 auto;font-family:Verdana,sans-serif;color:#28251f;background:#fbf4e8;padding:20px"><header style="text-align:center;padding:20px 10px;background:#fff;border:1px solid #eadcc8"><p style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:${accent};margin:0">${brand}</p><h1 style="font:700 31px Georgia,serif;line-height:1.15;margin:17px 0 10px">${title}</h1><p style="font-size:14px;line-height:1.6;margin:0">${kicker}</p></header><section style="padding:22px 10px">${sections.map((section, i) => `<div style="display:inline-block;vertical-align:top;width:calc(50% - 18px);margin:0 12px 20px 0;background:#fff;padding:16px;border-top:3px solid ${i % 2 ? accent : '#c99562'}"><h2 style="font:700 18px Georgia,serif;margin:0 0 8px">${section}</h2><p style="font-size:13px;line-height:1.65;margin:0">${details[i]}</p></div>`).join('')}</section><div style="text-align:center;padding:8px 0 26px"><a href="${href}" style="display:inline-block;border:2px solid ${accent};color:${accent};padding:11px 19px;text-decoration:none;font-weight:700">Save this edition</a></div><footer style="text-align:center;border-top:1px solid #eadcc8;padding-top:15px;font-size:11px;line-height:1.5;color:#796f62">${brand} · a fictional self-contained edition for MailVault’s browser demo</footer></div>`,
];

const FILLERS = [
  ['The Tuesday review is moved', 'The review is now at three. I added the two decisions we should make before opening the deck.', 0, 'INBOX'],
  ['A note about the studio key', 'The spare key is in the labelled drawer beside the paper samples. I left a note for the evening team.', 0, 'INBOX'],
  ['Draft agenda for the partner call', 'I kept the agenda to four points and put the open question about delivery at the end.', 0, 'INBOX'],
  ['A cleaner way to name exports', 'The client and project names are enough context. The date belongs at the end so the files sort naturally.', 0, 'INBOX'],
  ['The new proof folder is ready', 'I moved the approved proof and left the working notes in the review folder for context.', 0, 'INBOX'],
  ['A short thank-you from the team', 'The workshop notes helped us make a decision quickly. Thank you for writing them down while the details were fresh.', 0, 'INBOX'],
  ['Question about the quiet room', 'Is the quiet room free after lunch on Thursday? I would like to record the handoff without interruptions.', 0, 'INBOX'],
  ['The supplier sent a swatch card', 'The deep green is less blue than the screen preview. I left the card under the current paper samples.', 0, 'INBOX'],
  ['One last check on the contact list', 'The first three names are current. I highlighted the two entries that still need a preferred address.', 0, 'INBOX'],
  ['A useful shortcut for the next review', 'Open the summary first, then the source notes. That order answers the common questions without a long preamble.', 0, 'INBOX'],
  ['April delivery window', 'The delivery window is 09:00–11:00, with a call from the driver before arrival.', 0, 'INBOX'],
  ['The copy deck has a new ending', 'The final section now points to the handoff guide rather than repeating the benefits list.', 0, 'INBOX'],
  ['A question about the archive index', 'Could we keep the old client label in the index even after the folder is moved? It is useful historical context.', 0, 'INBOX'],
  ['The Friday lunch count', 'I have eight confirmed and two maybes. The café can add one table if we answer by Wednesday.', 0, 'INBOX'],
  ['A small improvement to the intake form', 'The form now asks for the intended audience before the delivery format, which avoids a surprising amount of rework.', 0, 'INBOX'],
  ['The team photo is finally usable', 'The new crop leaves everyone visible and gives the mark enough breathing room in the corner.', 0, 'INBOX'],
  ['A note for whoever opens the room', 'The projector cable is in the blue case, and the spare adapter is taped inside the lid.', 0, 'INBOX'],
  ['The handoff checklist has a date', 'I added the review date to each open item so the list can be useful without a separate calendar.', 0, 'INBOX'],
  ['A calmer default for the dashboard', 'I removed the extra counter from the first view. The detail remains one click away when someone needs it.', 0, 'INBOX'],
  ['The final client question', 'They want to know which files are safe to edit. I marked source files in the handoff and explained the naming.', 0, 'INBOX'],
  ['Personal: a book for the train', 'The little essays about rooms and weather were exactly what I wanted for the journey.', 1, 'INBOX'],
  ['Personal: keys found', 'They were in the pocket of the raincoat after all. No need to change the lock.', 1, 'INBOX'],
  ['Personal: dinner moved earlier', 'The table is now at 18:30, which gives us plenty of time for the last train home.', 1, 'INBOX'],
  ['The selected print set', 'I selected twelve images for the studio archive and removed the near duplicates. The small set tells the weekend better.', 0, 'INBOX'],
  ['Accounts: receipt for the paper order', 'The receipt matches the order and is filed under supplies for this quarter.', 2, 'INBOX'],
  ['Accounts: renewal date confirmed', 'The renewal remains in September. I added a reminder one month before the review.', 2, 'INBOX'],
  ['Accounts: one question on the invoice', 'The tax line is correct, but the project reference needs the new client code.', 2, 'INBOX'],
  ['Accounts: monthly records filed', 'The monthly records are complete and the outstanding note is now closed.', 2, 'INBOX'],
];

const ACCOUNT_EXPANSION_TOPICS = {
  1: [
    ['A good route for Saturday', 'The river path ends beside the bakery, with enough time left for the bookshop before lunch.'],
    ['The reading list for autumn', 'I kept the essays and removed the two books we already discussed at length.'],
    ['Keys for the spare room', 'The spare set is labelled and sits in the blue dish by the hallway lamp.'],
    ['A small change to dinner plans', 'The table moved to half past six, which makes the last train home comfortable.'],
    ['The garden needs one more pot', 'The rosemary has outgrown its first pot. I found a terracotta one that should drain properly.'],
    ['Notes from the film night', 'The quiet documentary was the best choice. I wrote down the director so we can find the earlier work.'],
    ['A parcel for the neighbour', 'The parcel is safe here until Sunday afternoon. I left the collection note by the front door.'],
    ['The blue coat is repaired', 'The button is back on and the pocket is stitched. It is ready for the first cold walk.'],
    ['A reminder about the library', 'The books are due next Wednesday. I renewed the travel guide and returned the duplicate.'],
    ['The weekend market list', 'Paper, lemons, and the small jar of honey are the only things we need this time.'],
    ['A note from the book club', 'The next discussion will start with the final chapter, where everyone found a different answer.'],
    ['The train has a quiet carriage', 'The middle service still has seats together, and the quiet carriage begins behind the café.'],
    ['A recipe with fewer steps', 'I rewrote the soup recipe around the ingredients we actually keep in the cupboard.'],
    ['The houseplant is recovering', 'It has a new leaf after moving away from the radiator. I will water it less often.'],
    ['A date for the coastal walk', 'The second Saturday has the best tide, so I marked it as the first choice in the calendar.'],
    ['The photo prints arrived', 'The matte paper suits the window-light set. I put the small stack beside the album.'],
    ['A quiet plan for Sunday', 'Coffee first, then the long route if the sky stays clear. There is no need to fill every hour.'],
    ['The borrowed camera is ready', 'The battery is charged and the strap is packed. I will return it after the harbour walk.'],
  ],
  2: [
    ['The monthly ledger is reconciled', 'The receipts now match the bank export, and the one late payment has its settlement date recorded.'],
    ['A question on the supplier terms', 'The renewal clause is unchanged. I highlighted the notice period before sending the summary.'],
    ['The invoice reference is corrected', 'The project code now matches the current client record, so the tax line can remain as filed.'],
    ['Quarterly review agenda', 'The review needs three decisions: cash timing, open credits, and the archive note for duplicates.'],
    ['The account contact is current', 'Studio Accounts remains the billing contact, with the secondary notice address kept for continuity.'],
    ['A receipt for paper supplies', 'The order arrived in two parcels. I attached the receipt to the supply record and closed the delivery note.'],
    ['The September renewal window', 'The renewal can proceed in the second week of September after the reviewer checks the printed summary.'],
    ['A clean export for the accountant', 'The export separates billed, received, and carried-forward totals so the quarter can be checked quickly.'],
    ['The duplicate payment is marked', 'The duplicate remains in the archive with a note, while the working view shows only the settled payment.'],
    ['Security review is scheduled', 'The second reviewer is booked for Friday, and the change history is ready beside the account notice.'],
    ['A note about the old statement', 'The old statement stays with the correction because it explains why the working total changed.'],
    ['The vendor summary is one page', 'Contact, renewal, and security details now print in that order without splitting across sheets.'],
    ['The bank notice is filed', 'The notice is stored with the monthly records and the next review date is visible in the index.'],
    ['A smaller close checklist', 'I moved the source receipt beside the total and removed repeated instructions from the closing page.'],
    ['The carried-forward total is stable', 'Nothing changed in the carry-forward column after the late payment was assigned to its correct month.'],
    ['Account handoff notes', 'The handoff names the reviewer, the renewal month, and the folder where the signed summary lives.'],
    ['A reminder before year end', 'The archive review is set for November so the old statements are checked before the annual close.'],
    ['The supplier confirmed delivery', 'The final box arrived intact, and the delivery note now points to the matching purchase record.'],
  ],
};

export function buildEnrichmentMessages({ sessionNow, accounts, accountIds, makeMessage, demoPdf, initialMessages = [] }) {
  const messages = [];
  const saturdayRouteNotes = 'U2F0dXJkYXkgcm91dGUgbm90ZXMKCk1lZXQgdW5kZXIgdGhlIG9sZCBjbG9jayBhdCB0ZW4uIFRoZSBtYXJrZXQgc3RhbGwgaXMgYmVzaWRlIHRoZSBjb3ZlcmVkIGFyY2FkZTsgQnJpbmUgJiBCb2FyZCBpcyBoZWxkIGZvciAxMjozMC4=';
  let uid = 102;
  const recentThreadDate = (index) => new Date(Math.min(
    sessionNow - 1000,
    sessionNow - (((9 - index) * 10.5) + 2) * 3600000,
  )).toISOString();
  for (const thread of THREADS) {
    const account = accounts[thread.account];
    const chainIds = [];
    let previousId = null;
    thread.messages.forEach(([subject, text], index) => {
      const incoming = index % 2 === 0;
      const messageId = `<demo-${thread.id}-${String(index + 1).padStart(3, '0')}@mailvault.demo>`;
      const parentId = previousId;
      const body = `${text}\n\n${THREAD_FOLLOWUPS[thread.id][index % THREAD_FOLLOWUPS[thread.id].length]}`;
      const hasPdfAttachment = (thread.id === 'brand-refresh' && index === 8)
        || (thread.id === 'weekend-table' && index === 6)
        || (thread.id === 'quarterly-close' && index === 8)
        || (thread.id === 'vendor-renewal' && index === 8);
      const row = makeMessage({
        accountId: accountIds[thread.account], mailbox: incoming ? 'INBOX' : 'Sent', uid: uid++,
        from: incoming ? thread.participant : participant(account.name, account.email),
        to: incoming ? [participant(account.name, account.email)] : [thread.participant], subject, text: body,
        dateOverride: thread.id === 'brand-refresh' ? recentThreadDate(index) : safeDate(sessionNow, thread.bucket, index * 18), unread: incoming && index % 4 === 0,
        flagged: index === 4, vault: index % 3 !== 1, server: true, threadId: thread.id,
        messageId, inReplyTo: parentId, references: chainIds.slice(),
        attachment: hasPdfAttachment ? { name: `${thread.id}-notes.pdf`, mimeType: 'application/pdf', size: 589, contentBase64: demoPdf } : null,
        attachments: thread.id === 'weekend-table' && index === 6
          ? [{ name: 'saturday-route-notes.txt', mimeType: 'text/plain', size: 128, contentBase64: saturdayRouteNotes }]
          : [],
      }, sessionNow);
      messages.push(row);
      chainIds.push(messageId);
      previousId = messageId;
    });
  }

  const newsletterText = (spec, details) => `${spec[2]}\n\n${spec[3]}\n\n${spec[4].map((section, index) => `${index + 1}. ${section}\n${details[index]}`).join('\n\n')}\n\nRead the full note in the MailVault browser demo.`;
  NEWSLETTERS.forEach((spec, index) => {
    const [brand, accent, kicker, title, sections] = spec;
    const details = NEWSLETTER_DETAILS[index];
    const html = NEWSLETTER_LAYOUTS[index % NEWSLETTER_LAYOUTS.length]({ brand, accent, kicker, title, sections, details, href: newsletterHref(brand) });
    const account = index < 8 ? 0 : index < 10 ? 1 : 2;
    const mailbox = 'INBOX';
    messages.push(makeMessage({
      accountId: accountIds[account], mailbox, uid: account === 0 ? 180 + index : account === 1 ? 188 + index : 190 + index,
      from: participant(brand, `${brand.toLowerCase().replace(/[^a-z]+/g, '')}@newsletter.example`),
      subject: `${brand} — ${title}`, text: newsletterText(spec, details), htmlContent: html, multipartAlternative: true,
      dateOverride: index === 0 ? new Date(sessionNow - 3 * 3600000).toISOString() : safeDate(sessionNow, 75 + index), unread: index % 3 === 0, flagged: index === 3,
      vault: index % 4 !== 1, server: true, threadId: `newsletter-${index}`,
    }, sessionNow));
  });

  let otherFillerUid = 450;
  FILLERS.forEach(([subject, text, account, mailbox], index) => {
    if (account === 0) return;
    messages.push(makeMessage({
      accountId: accountIds[account], mailbox, uid: otherFillerUid++,
      from: participant(account === 0 ? ['Theo Park', 'theo@fieldnotes.example'][0] : account === 1 ? 'Ida Marsh' : 'Studio Bank', account === 0 ? 'theo@fieldnotes.example' : account === 1 ? 'ida.marsh@fastmail.example' : 'notices@studiobank.example'),
      subject, text, dateOverride: safeDate(sessionNow, 90 + index), unread: index % 5 === 0, flagged: index % 11 === 0,
      vault: index % 4 !== 1, server: true,
    }, sessionNow));
  });

  const expansionContacts = {
    1: participant('Ida Marsh', 'ida.marsh@fastmail.example'),
    2: participant('Dario Vella', 'dario@rackandrind.com'),
  };
  const expansionMailboxes = ['INBOX', 'INBOX', 'INBOX', 'Sent', 'INBOX', 'Archive', 'INBOX', 'INBOX', 'Sent', 'INBOX', 'INBOX', 'INBOX'];
  for (const accountIndex of [1, 2]) {
    const account = accounts[accountIndex];
    const contact = expansionContacts[accountIndex];
    const topics = ACCOUNT_EXPANSION_TOPICS[accountIndex];
    const existing = initialMessages.filter(message => message.accountId === accountIds[accountIndex]).length
      + messages.filter(message => message.accountId === accountIds[accountIndex]).length;
    const needed = Math.max(0, 100 - existing);
    for (let index = 0; index < needed; index += 1) {
      const [topic, detail] = topics[index % topics.length];
      const mailbox = expansionMailboxes[index % expansionMailboxes.length];
      const outgoing = mailbox === 'Sent';
      const suffix = index >= topics.length ? ' I left the final decision beside the original note for the next review.' : '';
      messages.push(makeMessage({
        accountId: accountIds[accountIndex], mailbox, uid: 520 + accountIndex * 100 + index,
        from: outgoing ? participant(account.name, account.email) : contact,
        to: outgoing ? [contact] : [participant(account.name, account.email)],
        subject: outgoing ? `Re: ${topic}` : topic, text: `${detail}${suffix}`,
        dateOverride: safeDate(sessionNow, 115 + index + accountIndex * 7, (index % 3) * 8),
        unread: !outgoing && index % 7 === 0, flagged: index % 17 === 0,
        vault: index % 4 !== 1, server: true,
      }, sessionNow));
    }
  }
  return messages;
}
