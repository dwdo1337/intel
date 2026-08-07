import { Logo } from '../components/Logo';

export function BootScreen() {
  return (
    <div className="screen active boot-center">
      <div className="boot-box">
        <div className="logo" style={{ justifyContent: 'center', marginBottom: 24, fontSize: 24 }}>
          <Logo size={28} />
          intel.<span>.</span>
        </div>
        <div className="boot-spinner" />
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>boot sequence</div>
        <div style={{ color: 'var(--muted)', fontSize: 13 }}>Verifying sources and loading monitors...</div>
      </div>
    </div>
  );
}
