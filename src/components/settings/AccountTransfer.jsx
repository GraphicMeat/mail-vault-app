// "Set up the mobile app" and "Move to another computer" (views/AccountTransferView.jsx) in the
// desktop context, so it keeps working where it is rendered bare.
import { withDesktopEnv } from './DesktopViewEnv';
import { AccountTransferView } from './views/AccountTransferView';

export const AccountTransfer = withDesktopEnv(AccountTransferView);
