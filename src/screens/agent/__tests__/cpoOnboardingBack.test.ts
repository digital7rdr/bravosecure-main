/**
 * Static source-scan regression for the CPO document-verification back buttons.
 *
 * These screens can't be imported by the node `booking` project. Two founder
 * bugs (B-199):
 *  - the docs-upload back was a silent no-op in CpoOnboardingNavigator (its
 *    fallback `replace('AgentAvailability')` targets a route not registered in
 *    that stack). Back must do something — sign out, the only real "previous
 *    page" for a managed CPO who starts on this screen.
 *  - the post-submit approval screen was back-navigable and looped to a
 *    "submitted"-looking docs page. It must be terminal: no header back, no
 *    "Back to Dashboard", hardware/gesture back swallowed; the poll auto-
 *    advances only when ops decides.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const DOCS = 'src/screens/agent/AgentDocsUploadScreen.tsx';
const APPROVAL = 'src/screens/agent/AgentAdminApprovalScreen.tsx';
const CPO_NAV = 'src/navigation/CpoOnboardingNavigator.tsx';

describe('B-199 — CPO onboarding back behaviour (static source scan)', () => {
  describe('AgentDocsUpload (entry, pre-submit)', () => {
    it('C1: back signs out when the linear previous step is not in this stack', () => {
      const src = strip(read(DOCS));
      // Guards the fallback against the CPO stack, where AgentAvailability is
      // not registered, then signs out instead of a silent no-op.
      expect(src).toMatch(/routeNames\.includes\(prev\)/);
      expect(src).toMatch(/signOut\(\)/);
    });

    it('C2: an already-submitted CPO is redirected off the docs screen', () => {
      const src = strip(read(DOCS));
      expect(src).toMatch(/SUBMITTED[\s\S]*?replace\('AgentAdminApproval'\)/);
    });
  });

  describe('AgentAdminApproval (post-submit, terminal)', () => {
    it('D1: no back chevron — NavHeader is rendered without onBack', () => {
      const header = strip(read(APPROVAL));
      const start = header.indexOf('<NavHeader');
      const end = header.indexOf('/>', start);
      expect(start).toBeGreaterThan(-1);
      expect(header.slice(start, end)).not.toMatch(/onBack/);
    });

    it('D2: hardware/gesture back is swallowed', () => {
      const src = strip(read(APPROVAL));
      expect(src).toMatch(/hardwareBackPress['"],\s*\(\) => true/);
    });

    it('D3: the "Back to Dashboard" CTA is gone (it looped to submitted)', () => {
      expect(strip(read(APPROVAL))).not.toMatch(/Back to Dashboard/);
    });

    it('D4: the navigator disables the swipe gesture for this route', () => {
      const src = strip(read(CPO_NAV));
      expect(src).toMatch(/name="AgentAdminApproval"[\s\S]*?gestureEnabled: false/);
    });
  });
});
