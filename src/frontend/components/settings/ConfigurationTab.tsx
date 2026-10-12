import { useState } from 'react';
import { ExternalLink, Plus, X } from 'lucide-react';
import type { ConfigIntent } from '../../config/ConfigEditor';
import type { BotSettings } from '../../lib/types';
import { channelLabel, normChannel } from '../../lib/channel';
import { FieldRow, inputCls, ResetTabButton, SectionTitle, selectCls, Toggle } from './SettingsPrimitives';
import { channelJoinControls } from '../../lib/botStatusPresentation';
import { CHAT_MODELS } from '../../../utils/chat_models.js';

const connectionActionCls = 'flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-line bg-bg px-2.5 py-1.5 text-[11px] font-medium text-ink transition-colors hover:border-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60';

interface Props {
  value: BotSettings;
  busy: boolean;
  botUsername: string;
  botAuthorized: boolean;
  joinedChannels: string[];
  channelStatuses: Record<string, { authorized?: boolean; linked?: boolean; needsRelink?: boolean }>;
  dispatch: (intent: ConfigIntent) => void;
  onAuthorizeBot: () => void;
  onAuthorizeBroadcaster: (channel: string) => void;
}

export default function ConfigurationTab({
  value,
  busy,
  botUsername,
  botAuthorized,
  joinedChannels,
  channelStatuses,
  dispatch,
  onAuthorizeBot,
  onAuthorizeBroadcaster,
}: Props) {
  const [newChannel, setNewChannel] = useState('');
  const [newIgnoredUser, setNewIgnoredUser] = useState('');
  const joinControls = channelJoinControls(botAuthorized);
  const joined = new Set(joinedChannels.map(normChannel));
  const change = <K extends keyof BotSettings>(field: K, next: BotSettings[K]) => {
    dispatch({ type: 'bot-setting.changed', field, value: next });
  };
  const addChannel = () => {
    const channel = normChannel(newChannel.trim()).replace(/[^a-z0-9_]/g, '');
    if (channel && !value.channels.includes(channel)) dispatch({ type: 'channel.added', channel });
    setNewChannel('');
  };
  const addIgnoredUsers = () => {
    const current = value.ignored_usernames || [];
    const usernames = newIgnoredUser.split(/[,\s]+/)
      .map((entry) => entry.trim().toLowerCase().replace(/^@/, '').replace(/[^a-z0-9_]/g, ''))
      .filter((entry) => entry && !current.includes(entry));
    if (usernames.length) dispatch({ type: 'ignored-users.added', usernames });
    setNewIgnoredUser('');
  };

  return (
    <div className="space-y-4">
      <SectionTitle>Connection & channels</SectionTitle>
      <div className="flex items-center justify-between gap-3 border-b border-line/30 py-2">
        <div className="min-w-0">
          <div className="text-[12.5px] font-medium text-ink">Bot account</div>
          <div className="mt-1 flex items-center gap-2">
            <span className="rounded-md border border-line bg-bg px-2.5 py-1 font-mono text-[11.5px] text-muted">
              {botUsername ? botUsername.replace(/^@/, '') : 'Not configured'}
            </span>
            <span className={`rounded px-2 py-1 text-[10px] font-semibold ${botAuthorized ? 'bg-emerald-400/10 text-emerald-400' : 'bg-amber-400/10 text-amber-400'}`}>
              {botAuthorized ? 'Authorized' : 'Authorization required'}
            </span>
          </div>
        </div>
        <button type="button" onClick={onAuthorizeBot} className={connectionActionCls}>
          <ExternalLink size={11} /> {botAuthorized ? 'Reauthorize' : 'Authorize'}
        </button>
      </div>
      <div className="py-2 border-b border-line/30">
        <div className="text-[12.5px] font-medium text-ink">Configured channels</div>
        {value.channels.length > 0 && (
          <div className="mt-2 space-y-1">
            {value.channels.map((channel) => {
              const normalized = normChannel(channel);
              const status = channelStatuses[normalized] ?? channelStatuses[`#${normalized}`] ?? {};
              const broadcasterLinked = status.authorized === true && status.needsRelink !== true;
              return (
                <div key={channel} className="flex items-start justify-between gap-3 py-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span className="flex items-center gap-1.5 rounded-md border border-line bg-bg px-2.5 py-1 font-mono text-[11.5px] text-ink">
                      #{channelLabel(channel)}
                      <button type="button" onClick={() => dispatch({ type: 'channel.removed', channel })} aria-label={`Remove ${channel}`} title={`Remove #${channelLabel(channel)}`} className="ml-0.5 cursor-pointer text-faint transition-colors hover:text-ink focus-visible:outline-none focus-visible:text-ink">
                        <X size={11} />
                      </button>
                    </span>
                    <span className={`rounded px-2 py-1 text-[10px] font-semibold ${joined.has(normalized) ? 'bg-emerald-400/10 text-emerald-400' : 'bg-amber-400/10 text-amber-400'}`}>
                      Chat {joined.has(normalized) ? 'joined' : 'not joined'}
                    </span>
                    <span className={`rounded px-2 py-1 text-[10px] font-semibold ${broadcasterLinked ? 'bg-emerald-400/10 text-emerald-400' : 'bg-amber-400/10 text-amber-400'}`}>
                      Broadcaster {broadcasterLinked ? 'linked' : status.needsRelink ? 'relink required' : 'not linked'}
                    </span>
                  </div>
                  <button type="button" onClick={() => onAuthorizeBroadcaster(channel)} className={connectionActionCls}>
                    <ExternalLink size={11} /> {broadcasterLinked || status.needsRelink ? 'Relink' : 'Link'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <div className="mt-2 flex gap-1.5">
          <input disabled={joinControls.disabled} value={newChannel} onChange={(event) => setNewChannel(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && addChannel()} placeholder="add channel name…" className={`w-44 disabled:cursor-not-allowed disabled:opacity-50 ${inputCls}`} />
          <button disabled={joinControls.disabled} onClick={addChannel} className="flex cursor-pointer items-center gap-1 rounded-md border border-line bg-bg px-2.5 py-1.5 text-[11.5px] font-medium text-muted transition-colors hover:border-accent/50 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-line disabled:hover:text-muted"><Plus size={12} />Join</button>
        </div>
        {joinControls.helper && <p className="mt-1.5 text-[11px] text-amber-400">{joinControls.helper}</p>}
      </div>
      <div className="py-2">
        <div className="text-[12.5px] font-medium text-ink">Ignored users</div>
        <div className="mt-0.5 text-[11px] text-muted">e.g. other bots</div>
        {(value.ignored_usernames || []).length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {value.ignored_usernames.map((username) => (
              <span key={username} className="flex items-center gap-1.5 rounded-md border border-line bg-bg px-2 py-1 font-mono text-[11px] text-ink">
                {username}
                <button onClick={() => dispatch({ type: 'ignored-user.removed', username })} aria-label={`Remove ${username}`} className="ml-0.5 cursor-pointer text-faint transition-colors hover:text-ink"><X size={11} /></button>
              </span>
            ))}
          </div>
        )}
        <div className="mt-2 flex gap-1.5">
          <input value={newIgnoredUser} onChange={(event) => setNewIgnoredUser(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && addIgnoredUsers()} placeholder="add username…" className={`w-44 ${inputCls}`} />
          <button onClick={addIgnoredUsers} className="flex cursor-pointer items-center gap-1 rounded-md border border-line bg-bg px-2.5 py-1.5 text-[11.5px] font-medium text-muted transition-colors hover:border-accent/50 hover:text-ink"><Plus size={12} />Ignore</button>
        </div>
      </div>

      <SectionTitle>Chat behavior</SectionTitle>
      <FieldRow label="Bot command" hint="Triggers for AI responses in chat">
        <input value={value.bot_command_name} onChange={(event) => change('bot_command_name', event.target.value)} placeholder="!gemini,@yourbotusername" className={`w-52 ${inputCls}`} />
      </FieldRow>
      <FieldRow label="Reply behavior">
        <select value={value.reply_mode} onChange={(event) => change('reply_mode', event.target.value as BotSettings['reply_mode'])} className={selectCls}>
          <option value="off">Off</option><option value="tag">Tag user</option><option value="reply">Twitch reply</option>
        </select>
      </FieldRow>
      <FieldRow label="Response cooldown (sec)">
        <input type="number" min={0} max={60} value={value.cooldown_duration} onChange={(event) => change('cooldown_duration', Math.max(0, parseInt(event.target.value, 10) || 0))} className={`w-24 ${inputCls}`} />
      </FieldRow>
      <FieldRow label="Ignore emote-only prompts"><Toggle on={value.ignore_emote_only_prompts} onChange={(next) => change('ignore_emote_only_prompts', next)} /></FieldRow>
      <FieldRow label="Append channel emotes to responses" noBorder><Toggle on={value.enable_emote_appending} onChange={(next) => change('enable_emote_appending', next)} /></FieldRow>

      <SectionTitle>AI & search</SectionTitle>
      <FieldRow label="Gemini model">
        <select value={value.model_name} onChange={(event) => change('model_name', event.target.value)} className={selectCls}>
          {CHAT_MODELS.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
        </select>
      </FieldRow>
      <FieldRow label="Thinking level">
        <select value={value.thinking_level} onChange={(event) => change('thinking_level', event.target.value)} className={selectCls}>
          <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
        </select>
      </FieldRow>
      <FieldRow label="Conversation memory" hint="Dialogue turns the bot remembers per channel">
        <input type="number" min={0} max={30} value={value.ai_history_length} onChange={(event) => change('ai_history_length', Math.max(0, parseInt(event.target.value, 10) || 0))} className={`w-24 ${inputCls}`} />
      </FieldRow>
      <FieldRow label="Chat context" hint="Recent messages the bot can see">
        <input type="number" min={1} max={50} value={value.chat_context_length} onChange={(event) => change('chat_context_length', Math.max(1, parseInt(event.target.value, 10) || 20))} className={`w-24 ${inputCls}`} />
      </FieldRow>
      <FieldRow label="Web search" noBorder={value.search_grounding !== 'tavily'}>
        <select value={value.search_grounding} onChange={(event) => change('search_grounding', event.target.value)} className={selectCls}>
          <option value="">Off</option><option value="tavily">Tavily</option><option value="google">Google</option>
        </select>
      </FieldRow>
      {value.search_grounding === 'tavily' && (
        <FieldRow label="Search level" noBorder>
          <select value={value.tavily_search_depth || 'basic'} onChange={(event) => change('tavily_search_depth', event.target.value)} className={selectCls}>
            <option value="basic">Basic (1 credit)</option><option value="advanced">Advanced (2 credits)</option>
          </select>
        </FieldRow>
      )}

      <SectionTitle>Display</SectionTitle>
      <FieldRow label="Highlight bot replies in dashboard" noBorder><Toggle on={value.highlight_bot_responses} onChange={(next) => change('highlight_bot_responses', next)} /></FieldRow>
      <ResetTabButton onReset={() => dispatch({ type: 'domain.reset', domain: 'bot_settings' })} disabled={busy} />
    </div>
  );
}
