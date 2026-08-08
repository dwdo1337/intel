import { useEffect, useState } from 'react';
import './sources.css';

/**
 * Source manager: pick which groups to watch, and set per-group sender rules.
 *
 * Semantics shown to the user, and enforced identically in the backend:
 *   no groups picked  -> watch every group
 *   groups picked     -> watch only those
 *   no senders listed -> everyone in that group counts
 *   allow-list set    -> only those people
 *   block-list        -> always dropped, even if also allowed
 */
export function SourcesManager({ onClose }) {
  const [tab, setTab] = useState('telegram');
  const [tgChats, setTgChats] = useState([]);
  const [dcGuilds, setDcGuilds] = useState([]);
  const [selTg, setSelTg] = useState(new Set());
  const [selDc, setSelDc] = useState(new Set());
  const [rules, setRules] = useState({});
  const [ruleFor, setRuleFor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState('');
  // Which servers are expanded. Collapsed by DEFAULT: a user token sees every
  // guild it belongs to, and one account here has 18 servers / 1295 channels
  // (435 in a single server). Rendering them all expanded is a wall nobody can
  // pick from -- you choose a server first, then its channels.
  const [openGuilds, setOpenGuilds] = useState(() => new Set());
  // Whole SERVERS being watched, separate from individual channels. Selecting a
  // server watches all of it; picking channels inside one narrows it to those.
  const [selGuild, setSelGuild] = useState(new Set());

  useEffect(() => {
    (async () => {
      try {
        const [cur, tg, dc] = await Promise.all([
          fetch('/api/sources').then(r => r.json()),
          fetch('/api/telegram/chats').then(r => r.json()),
          fetch('/api/discord/channels').then(r => r.json()),
        ]);
        setSelTg(new Set((cur.telegram_chats || []).map(String)));
        setSelDc(new Set((cur.discord_channels || []).map(String)));
        setSelGuild(new Set((cur.discord_guilds || []).map(String)));
        setRules(cur.chat_rules || {});
        setTgChats(tg.chats || []);
        setDcGuilds(dc.guilds || []);
        if (tg.ok === false && tg.error) setErr('Telegram: ' + tg.error);
      } catch (e) { setErr(e.message); }
      finally { setLoading(false); }
    })();
  }, []);

  const toggle = (set, setter, id) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    setter(next);
  };

  const save = async () => {
    setSaving(true); setErr(null);
    try {
      const r = await fetch('/api/sources', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegram_chats: [...selTg],
          discord_guilds: [...selGuild],
          discord_channels: [...selDc],
          chat_rules: rules,
        }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'Save failed');
      onClose?.();
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  };

  const setRule = (key, field, raw) => {
    const list = raw.split(',').map(s => s.trim().replace(/^@/, '')).filter(Boolean);
    setRules(prev => {
      const next = { ...prev };
      const entry = { ...(next[key] || { allowed: [], blocked: [] }) };
      entry[field] = list;
      if (!entry.allowed?.length && !entry.blocked?.length) delete next[key];
      else next[key] = entry;
      return next;
    });
  };

  const activeSel = tab === 'telegram' ? selTg : selDc;
  const filterText = q.trim().toLowerCase();

  return (
    <div className="sm">
      <header className="sm-head">
        <div>
          <h2>Sources</h2>
          <p>
            {activeSel.size === 0
              ? 'No groups picked — watching every group you are in.'
              : `Watching ${activeSel.size} selected ${tab === 'telegram' ? 'chat' : 'channel'}${activeSel.size === 1 ? '' : 's'} only.`}
          </p>
        </div>
        <div className="sm-tabs">
          <button className={tab === 'telegram' ? 'on' : ''} onClick={() => setTab('telegram')}>
            Telegram {selTg.size > 0 && <span className="sm-count">{selTg.size}</span>}
          </button>
          <button className={tab === 'discord' ? 'on' : ''} onClick={() => setTab('discord')}>
            Discord {selDc.size > 0 && <span className="sm-count">{selDc.size}</span>}
          </button>
        </div>
      </header>

      <input
        className="sm-search"
        placeholder={tab === 'discord' ? 'Search servers and channels…' : 'Filter groups…'}
        value={q}
        onChange={e => setQ(e.target.value)}
      />

      <div className="sm-body">
        {loading ? <div className="sm-empty">Loading your groups…</div> : (
          tab === 'telegram' ? (
            tgChats.length === 0
              ? <div className="sm-empty">No Telegram groups found. Connect Telegram first.</div>
              : tgChats
                  .filter(ch => !filterText || ch.name.toLowerCase().includes(filterText))
                  .map(ch => (
                    <Row
                      key={ch.id}
                      id={ch.id}
                      name={ch.name}
                      meta={ch.kind}
                      on={selTg.has(ch.id)}
                      onToggle={() => toggle(selTg, setSelTg, ch.id)}
                      rule={rules[ch.name] || rules[ch.id]}
                      onRules={() => setRuleFor({ key: ch.name, label: ch.name })}
                    />
                  ))
          ) : (
            dcGuilds.length === 0
              ? <div className="sm-empty">No Discord channels seen yet. Connect Discord, then wait a moment for the server list.</div>
              : dcGuilds
                  .map(g => {
                    // A search matching the SERVER name keeps all its channels;
                    // otherwise the term filters channels within it.
                    const guildHit = !!filterText && g.name.toLowerCase().includes(filterText);
                    return {
                      ...g,
                      guildHit,
                      channels: (!filterText || guildHit)
                        ? g.channels
                        : g.channels.filter(ch => ch.name.toLowerCase().includes(filterText)),
                    };
                  })
                  .filter(g => g.channels.length)
                  .map(g => {
                    const selCount = g.channels.filter(ch => selDc.has(ch.id)).length;
                    // Searching expands automatically -- typing a channel name
                    // should show it, not just reveal which server holds it.
                    const open = openGuilds.has(g.name) || !!filterText;
                    const allOn = selCount === g.channels.length && selCount > 0;
                    const gid = g.id ? String(g.id) : null;
                    const wholeServer = !!gid && selGuild.has(gid);
                    // The server rule keys on the guild ID, so it survives the
                    // server being renamed.
                    const guildRule = gid ? rules[gid] : null;
                    const ruleCount = guildRule
                      ? (guildRule.allowed || []).length + (guildRule.blocked || []).length : 0;
                    return (
                      <div className={`sm-guild ${open ? 'open' : ''} ${wholeServer ? 'watched' : ''}`} key={g.name}>
                        <div className="sm-guild-head">
                          {/* Watch the WHOLE server. Selecting channels inside
                              it narrows that down; leaving them unpicked means
                              every channel. */}
                          <button
                            type="button"
                            className={`sm-guild-check ${wholeServer ? 'on' : ''}`}
                            disabled={!gid}
                            title={gid ? (wholeServer ? 'Watching the whole server' : 'Watch this whole server') : 'Server id unknown'}
                            onClick={() => gid && toggle(selGuild, setSelGuild, gid)}
                          >{wholeServer ? '✓' : ''}</button>
                          <button
                            type="button"
                            className="sm-guild-name"
                            aria-expanded={open}
                            onClick={() => setOpenGuilds(prev => {
                              const next = new Set(prev);
                              next.has(g.name) ? next.delete(g.name) : next.add(g.name);
                              return next;
                            })}
                          >
                            <span className={`sm-caret ${open ? 'open' : ''}`}>›</span>
                            <span className="sm-guild-label">{g.name}</span>
                            {/* What is actually being watched, readable while
                                collapsed -- otherwise you would have to expand
                                18 servers to find out. */}
                            {wholeServer && selCount === 0 && <span className="sm-guild-sel">all</span>}
                            {selCount > 0 && <span className="sm-guild-sel">{selCount} ch</span>}
                            <span className="sm-guild-count">{g.channels.length}</span>
                          </button>
                          {/* Members, same idea as Telegram's per-chat sender
                              rules -- but set once for the whole server instead
                              of retyped into all 400 of its channels. */}
                          <button
                            type="button"
                            className={`sm-members ${ruleCount ? 'on' : ''}`}
                            disabled={!gid}
                            title="Only take calls from certain members (or block some)"
                            onClick={() => setRuleFor({ key: gid, label: g.name + ' (whole server)' })}
                          >{ruleCount ? `${ruleCount} members` : 'Members'}</button>
                        </div>

                        {open && (
                          <>
                            <div className="sm-guild-tools">
                              {/* Says what the CURRENT selection actually does.
                                  "Whole server, or these channels?" is the one
                                  thing that is ambiguous here, so it is spelled
                                  out rather than left to be inferred. */}
                              <span className="sm-guild-hint">
                                {selCount > 0
                                  ? `Watching ${selCount} chosen channel${selCount === 1 ? '' : 's'}`
                                  : wholeServer
                                    ? 'Watching every channel in this server'
                                    : 'Not watched — tick the server, or pick channels'}
                              </span>
                              <button
                                type="button"
                                onClick={() => setSelDc(prev => {
                                  const next = new Set(prev);
                                  // Toggling a 435-channel server one row at a
                                  // time is not a real option.
                                  for (const ch of g.channels) allOn ? next.delete(ch.id) : next.add(ch.id);
                                  return next;
                                })}
                              >
                                {allOn ? 'Deselect all' : `Select all ${g.channels.length}`}
                              </button>
                            </div>
                            {g.channels.map(ch => (
                              <Row
                                key={ch.id}
                                id={ch.id}
                                name={'#' + ch.name}
                                on={selDc.has(ch.id)}
                                onToggle={() => toggle(selDc, setSelDc, ch.id)}
                                rule={rules[ch.id]}
                                onRules={() => setRuleFor({ key: ch.id, label: g.name + ' / #' + ch.name })}
                              />
                            ))}
                          </>
                        )}
                      </div>
                    );
                  })
          )
        )}
      </div>

      {ruleFor && (
        <div className="sm-rules">
          <div className="sm-rules-head">
            <span>Sender rules — <b>{ruleFor.label}</b></span>
            <button onClick={() => setRuleFor(null)}>&times;</button>
          </div>
          {/* Committed on CHANGE, not on blur. With onBlur alone, typing a name
              and going straight to Save lost it -- the input never blurred, so
              the rule was never recorded and the save wrote nothing. Silent,
              and indistinguishable from the feature not working. */}
          <label>Only these senders <em>(blank = everyone)</em></label>
          <input
            placeholder="alice, bob"
            defaultValue={(rules[ruleFor.key]?.allowed || []).join(', ')}
            onChange={e => setRule(ruleFor.key, 'allowed', e.target.value)}
          />
          <label>Never these senders <em>(always wins)</em></label>
          <input
            placeholder="spammer1, botname"
            defaultValue={(rules[ruleFor.key]?.blocked || []).join(', ')}
            onChange={e => setRule(ruleFor.key, 'blocked', e.target.value)}
          />
          <p className="sm-hint">
            Usernames without the @.{' '}
            {String(ruleFor.label || '').includes('(whole server)')
              ? 'Applies to every channel in this server, unless a channel has its own rule.'
              : 'Applies to this channel only.'}
          </p>
        </div>
      )}

      {err && <div className="sm-err">{err}</div>}

      <footer className="sm-foot">
        <span className="sm-note">Nothing selected = all groups watched.</span>
        <button className="sm-btn ghost" onClick={onClose}>Cancel</button>
        <button className="sm-btn solid" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save sources'}
        </button>
      </footer>
    </div>
  );
}

function Row({ name, meta, on, onToggle, rule, onRules }) {
  const hasRule = !!(rule && ((rule.allowed || []).length || (rule.blocked || []).length));
  return (
    <div className={`sm-row ${on ? 'on' : ''}`}>
      <label className="sm-row-main" onClick={onToggle}>
        <span className={`sm-check ${on ? 'on' : ''}`}>{on ? '✓' : ''}</span>
        <span className="sm-row-name">{name}</span>
        {meta && <span className="sm-row-meta">{meta}</span>}
      </label>
      <button className={`sm-rule-btn ${hasRule ? 'on' : ''}`} onClick={onRules}>
        {hasRule ? 'rules ●' : 'rules'}
      </button>
    </div>
  );
}
