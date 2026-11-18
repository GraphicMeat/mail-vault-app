// The reorderable list (views/ReorderListView.jsx) in the desktop context: accounts, views and
// quick actions are ordered with it.
import { withDesktopEnv } from './DesktopViewEnv';
import { ReorderListView } from './views/ReorderListView';

export const AccountReorderList = withDesktopEnv(ReorderListView);
