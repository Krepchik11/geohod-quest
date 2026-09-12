// The constructor's stylesheets, mounted with the constructor. They are ~48 KB
// of CSS that only an editor ever renders, so only an editor downloads them.
//
// `player-paper.css` is here because the constructor embeds the real player
// (live preview + TestPlayer) — the same sheet the /quest/[questId] route
// imports. Next emits it once and both routes share the chunk.
import '../styles/admin-shell.css';
import '../styles/admin-ctor.css';
import '../styles/ctor-dashboard.css';
import '../styles/ctor-workspace.css';
import '../styles/player-paper.css';

export default function QuestEditorLayout({ children }: { children: React.ReactNode }) {
  return children;
}
