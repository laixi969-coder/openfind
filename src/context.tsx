import { createContext, useContext } from 'react';
import type { Snapshot, Note, Draft } from '../shared/types';
export type Page =
  | 'acquisition'
  | 'discover'
  | 'comments'
  | 'leads'
  | 'inbox'
  | 'studio'
  | 'knowledge'
  | 'history'
  | 'settings';
export interface Workspace {
  data: Snapshot;
  refresh: () => Promise<void>;
  notify: (text: string, error?: boolean) => void;
  navigate: (page: Page) => void;
  clone: (note: Note) => void;
  editDraft: (draft: Draft) => void;
  newDraft: () => void;
  collect: (note: Note) => Promise<void>;
  commentNoteId: string;
  setCommentNoteId: (id: string) => void;
}
export const WorkspaceContext = createContext<Workspace | null>(null);
export function useWorkspace() {
  return useContext(WorkspaceContext)!;
}
