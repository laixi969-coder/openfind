import { Router } from 'express';
import { z } from 'zod';
import { modelsBusy } from './model-safety.ts';
import { all, configGet } from './store.ts';
import {
  backupStatus,
  backupRunning,
  runAutomaticBackup,
  saveBackupSettings,
  startAutomaticBackups,
  withBackupLease,
} from './auto-backup.ts';
import {
  cleanupPlan,
  executeCleanup,
  forgetCustomer,
  forgetPlan,
  retentionDays,
  setRetentionDays,
} from './data-maintenance.ts';

let working = false;
export const maintenanceBusy = () => working || backupRunning();
export function maintenanceRouter(busy: () => boolean) {
  const router = Router();
  const unavailable = () =>
    busy() ||
    backupRunning() ||
    modelsBusy() ||
    all<{ status: string }>('image-generations').some((g) => g.status === 'running');
  const exclusive = async <T>(work: () => Promise<T>) => {
    if (working || unavailable())
      throw Object.assign(new Error('请等待采集、模型或资料维护完成后再操作'), { statusCode: 409 });
    working = true;
    try {
      return await work();
    } finally {
      working = false;
    }
  };
  router.get('/maintenance', (_req, res) =>
    res.json({
      backup: backupStatus(),
      retentionDays: retentionDays(),
      lastCleanup: configGet('retention:lastCleanup'),
    }),
  );
  router.put('/maintenance', async (req, res) => {
    const input = z
      .object({
        backup: z
          .object({ enabled: z.boolean(), directory: z.string().trim().min(1).max(4096) })
          .strict(),
        retentionDays: z.number().int().min(1).max(3650),
      })
      .strict()
      .parse(req.body);
    res.json(
      await exclusive(async () => {
        const backup = saveBackupSettings(input.backup);
        setRetentionDays(input.retentionDays);
        return { backup, retentionDays: retentionDays() };
      }),
    );
  });
  router.post('/maintenance/backup', async (_req, res) =>
    res.json(await exclusive(runAutomaticBackup)),
  );
  router.post('/maintenance/cleanup', async (req, res) => {
    const input = z
      .object({ confirm: z.boolean().default(false), token: z.string().optional() })
      .strict()
      .parse(req.body);
    res.json(
      await exclusive(() =>
        withBackupLease(async () =>
          input.confirm ? executeCleanup(z.string().min(1).parse(input.token)) : cleanupPlan(),
        ),
      ),
    );
  });
  router.post('/maintenance/forget', async (req, res) => {
    const input = z
      .object({
        leadId: z.string().min(1).max(2000),
        confirm: z.boolean().default(false),
        token: z.string().optional(),
        includeBackups: z.boolean().default(false),
        includeLegacyModelReceipts: z.boolean().default(false),
      })
      .strict()
      .parse(req.body);
    res.json(
      await exclusive(() =>
        withBackupLease(async () =>
          input.confirm
            ? forgetCustomer(
                input.leadId,
                z.string().min(1).parse(input.token),
                input.includeBackups,
                input.includeLegacyModelReceipts,
              )
            : forgetPlan(input.leadId),
        ),
      ),
    );
  });
  startAutomaticBackups(() => working || unavailable());
  return router;
}
