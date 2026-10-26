import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth';
import { canUseSimulator } from '@/lib/rbac';
import { listGateways } from '@/lib/ingestion';
import { SimulatorPanel } from './simulator-panel';

export const dynamic = 'force-dynamic';

/**
 * Gateway registry + clearly-labeled simulator. SUPER_ADMIN only
 * (canUseSimulator). All mutations go through server actions that call
 * assertRole — the page guard is cosmetic.
 *
 * HONESTY: this page simulates BLE detections for development/demo. The
 * resulting movement rows are recorded with method='SIMULATED' and are
 * labeled as simulated in the UI and reports. No real hardware is involved.
 */
export default async function SimulatorPage() {
  const { profile } = await requireUser();
  if (!canUseSimulator(profile.role)) {
    redirect('/dashboard');
  }

  const gateways = await listGateways();

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-xl font-bold tracking-tight text-white">Gateway Registry &amp; Simulator</h1>
        <p className="mt-1 text-sm text-slate-400">
          Register BLE receivers and send <span className="text-ff-warning">simulated</span> detections
          through the real ingestion pipeline. Simulated rows are always labeled — never mixed with real device data.
        </p>
      </header>

      <SimulatorPanel gateways={gateways} />
    </div>
  );
}
