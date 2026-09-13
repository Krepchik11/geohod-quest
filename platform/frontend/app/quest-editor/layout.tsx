// ~48 KB of CSS only an editor renders. player-paper is here too because the
// constructor embeds the real player (live preview + TestPlayer).
import '../styles/admin-shell.css';
import '../styles/admin-ctor.css';
import '../styles/ctor-dashboard.css';
import '../styles/ctor-workspace.css';
import '../styles/player-paper.css';

export default function QuestEditorLayout({ children }: { children: React.ReactNode }) {
  return children;
}
