// Export this workspace as a zip (owners/admins) or import one as a new workspace.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, Upload } from 'lucide-react';
import { api, download } from '../api.ts';
import { errorToast, loadWorkspaces, toast } from '../store.ts';
import { platform } from '../platform/index.ts';
import { Button } from './ui.tsx';

export function WorkspaceData({ wsId, canExport }: { wsId: string; canExport: boolean }) {
  const [busy, setBusy] = useState<'export' | 'import' | null>(null);
  const navigate = useNavigate();

  const doExport = async () => {
    setBusy('export');
    try {
      const { blob, filename } = await download(`/workspaces/${wsId}/export`);
      await platform.saveFile(filename ?? 'workspace.zip', blob);
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(null);
    }
  };

  const doImport = async () => {
    const [file] = await platform.pickFiles({ accept: '.zip,application/zip' });
    if (!file) return;
    setBusy('import');
    try {
      const r = await api<{ workspaceId: string; name: string }>('/workspaces/import', {
        method: 'POST',
        body: file,
        headers: { 'Content-Type': 'application/zip' },
      });
      await loadWorkspaces();
      toast(`Imported as “${r.name}”`);
      navigate(`/w/${r.workspaceId}`);
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="row gap-10">
      {canExport && (
        <Button icon={<Download size={15} />} loading={busy === 'export'} disabled={!!busy} onClick={() => void doExport()}>
          Export workspace
        </Button>
      )}
      <Button icon={<Upload size={15} />} loading={busy === 'import'} disabled={!!busy} onClick={() => void doImport()}>
        Import from export…
      </Button>
    </div>
  );
}
