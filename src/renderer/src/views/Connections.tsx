import { useEffect, useState, type ReactNode } from 'react'
import { Check, Copy, ExternalLink } from 'lucide-react'
import type { Account, Platform, SecretField, Settings } from '@shared/types'
import { PLATFORMS } from '@shared/types'
import { api } from '../lib/api'
import { useData } from '../lib/hooks'
import { Button, cx, ErrorNote, Label, PageHeader, Pill, PlatformDot, Segmented } from '../components/ui'
import { useToast } from '../components/toast'
import { t } from '../lib/i18n'

type Key = Platform | 'ga4' | 'gcal' | 'anthropic' | 'storage'

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <button onClick={() => api.app.openExternal(href)} className="inline-flex items-center gap-1 text-ink underline underline-offset-4 decoration-[#555] hover:decoration-ink">
      {children}
      <ExternalLink size={11} />
    </button>
  )
}

function SecretInput({ field, label, hint, multiline, status, onSaved }: { field: SecretField; label: string; hint?: string; multiline?: boolean; status?: boolean; onSaved: () => void }) {
  const toast = useToast()
  const [value, setValue] = useState('')
  const [peek, setPeek] = useState('')
  useEffect(() => {
    if (status) void api.secrets.peek(field).then(setPeek)
    else setPeek('')
  }, [field, status])
  const save = async (): Promise<void> => {
    if (!value.trim()) return
    await api.secrets.set(field, value)
    setValue('')
    toast(t('{label} guardado y cifrado', { label }), 'success')
    onSaved()
  }
  return (
    <div>
      <Label hint={hint}>{label}</Label>
      <div className="flex gap-2 items-start">
        {multiline ? (
          <textarea className="field font-[inherit] min-h-[84px]" value={value} onChange={(e) => setValue(e.target.value)} placeholder={peek ? t('Guardado ({peek}). Pega uno nuevo para sustituirlo.', { peek }) : t('Pega el contenido')} />
        ) : (
          <input type="password" className="field" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save()}
            placeholder={peek ? t('Guardado {peek}', { peek }) : t('Sin guardar')} autoComplete="off" spellCheck={false} />
        )}
        <Button size="md" onClick={save} disabled={!value.trim()}>{t('Guardar')}</Button>
      </div>
    </div>
  )
}

function SettingInput({ k, label, hint, placeholder, settings, onSaved }: { k: keyof Settings; label: string; hint?: string; placeholder?: string; settings: Settings; onSaved: () => void }) {
  const [value, setValue] = useState(String(settings[k] ?? ''))
  useEffect(() => setValue(String(settings[k] ?? '')), [settings, k])
  return (
    <label className="block">
      <Label hint={hint}>{label}</Label>
      <input className="field" value={value} placeholder={placeholder} onChange={(e) => setValue(e.target.value)}
        onBlur={async () => {
          if (value !== String(settings[k] ?? '')) {
            await api.settings.save({ [k]: value.trim() } as Partial<Settings>)
            onSaved()
          }
        }} />
    </label>
  )
}

function Section({ id, title, mark, account, help, children, connect }: { id: Key; title: string; mark?: ReactNode; account?: Account; help: ReactNode; children: ReactNode; connect?: ReactNode }) {
  return (
    <section id={`c-${id}`} className="grid grid-cols-[minmax(0,380px)_minmax(0,1fr)] gap-8 py-8 border-t border-rule first:border-0 first:pt-0 max-[1100px]:grid-cols-1 max-[1100px]:gap-4">
      <div>
        <div className="flex items-center gap-2.5">
          {mark}
          <h2 className="text-[16px] font-medium">{title}</h2>
          {account && (account.connected ? <Pill tone="pos">{t('Conectado')}</Pill> : <Pill>{t('Sin conectar')}</Pill>)}
        </div>
        {account?.connected && account.displayName && <p className="text-[13px] text-ink mt-2">{account.displayName}</p>}
        <div className="text-[13px] text-muted mt-2 leading-relaxed flex flex-col gap-2">{help}</div>
      </div>
      <div className="bg-surface rounded-2xl p-5 flex flex-col gap-4">
        {children}
        {connect && <div className="flex items-center gap-2 pt-1">{connect}</div>}
      </div>
    </section>
  )
}

function ClaudeCodeStatusBox({ settings, onSaved }: { settings: Settings; onSaved: () => void }) {
  const status = useData(() => api.ai.claudeCodeStatus(), [settings.claudePath])
  const st = status.data
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 min-h-9">
        {status.loading || !st ? (
          <span className="text-[13px] text-faint">{t('Comprobando Claude Code…')}</span>
        ) : st.ok ? (
          <>
            <Pill tone="pos">{t('Listo')}</Pill>
            <span className="text-[13px] text-muted">
              Claude Code{' '}{st.version.replace(/\s*\(Claude Code\)/, '')}{st.plan ? ` · plan ${st.plan}` : ''}
            </span>
          </>
        ) : (
          <>
            <Pill tone="neg">{t('No disponible')}</Pill>
            <span className="text-[13px] text-neg-ink">{st.error}</span>
          </>
        )}
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={status.reload}>{t('Comprobar')}</Button>
      </div>
      <SettingInput k="claudePath" label={t('Ruta del ejecutable')} hint={st?.path ? t('Detectado: {path}', { path: st.path }) : t('Vacío: se busca automáticamente')} placeholder={t('Automática')} settings={settings} onSaved={onSaved} />
    </div>
  )
}

export function Connections() {
  const toast = useToast()
  const accounts = useData(() => api.accounts.list())
  const secrets = useData(() => api.secrets.status())
  const settings = useData(() => api.settings.get())
  const info = useData(() => api.app.info())
  const [busy, setBusy] = useState<Key | ''>('')
  const [errors, setErrors] = useState<Partial<Record<Key, string>>>({})
  const [copied, setCopied] = useState(false)

  const reload = (): void => {
    accounts.reload()
    secrets.reload()
    settings.reload()
  }
  const acc = (k: Key): Account | undefined => accounts.data?.find((a) => a.platform === k)
  const s = settings.data
  const st = secrets.data

  async function connect(k: Platform | 'ga4' | 'gcal'): Promise<void> {
    setBusy(k)
    setErrors((e) => ({ ...e, [k]: '' }))
    try {
      const name = await api.accounts.connect(k)
      toast(t('Conectado: {name}', { name }), 'success')
      reload()
    } catch (e) {
      setErrors((x) => ({ ...x, [k]: (e as Error).message }))
    } finally {
      setBusy('')
    }
  }
  async function disconnect(k: Platform | 'ga4' | 'gcal'): Promise<void> {
    await api.accounts.disconnect(k)
    reload()
  }
  const ConnectButtons = ({ k, label, ready = true }: { k: Platform | 'ga4' | 'gcal'; label?: string; ready?: boolean }) => (
    <>
      <Button variant={acc(k)?.connected ? 'secondary' : 'primary'} loading={busy === k} disabled={!ready} onClick={() => connect(k)}>
        {acc(k)?.connected ? t('Volver a conectar') : label ?? t('Conectar cuenta')}
      </Button>
      {acc(k)?.connected && <Button variant="ghost" onClick={() => disconnect(k)}>{t('Desconectar')}</Button>}
      {busy === k && k !== 'ga4' && k !== 'instagram' && k !== 'blog' && <span className="text-[12px] text-faint">{t('Termina el inicio de sesión en el navegador…')}</span>}
    </>
  )
  const Err = ({ k }: { k: Key }) => (errors[k] ? <ErrorNote>{errors[k]}</ErrorNote> : null)

  if (!s || !st || !accounts.data) return <PageHeader title={t('Conexiones')} />
  const redirect = info.data?.redirectUri ?? ''
  const connectedCount = accounts.data.filter((a) => a.connected).length

  const RedirectNote = () => (
    <p className="flex items-center gap-2 flex-wrap">
      {t('URL de redirección:')}
      <button className="inline-flex items-center gap-1.5 bg-raised rounded-md px-2 py-0.5 text-ink" onClick={async () => {
        await navigator.clipboard.writeText(redirect)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}>
        {redirect} {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </p>
  )

  return (
    <div className="anim-rise max-w-[1200px]">
      <PageHeader
        title={t('Conexiones')}
        subtitle={t('{n} de {total} conectadas. Las claves y los tokens se guardan cifrados con {method}.', { n: connectedCount, total: accounts.data.length, method: info.data?.encryption ?? t('el llavero del sistema') })}
      />

      <div className="flex flex-wrap gap-2 mb-8">
        {accounts.data.map((a) => (
          <a key={a.platform} href={`#c-${a.platform}`} className={cx('h-8 px-3 rounded-full inline-flex items-center gap-2 text-[13px] bg-surface hover:bg-hover', a.connected ? 'text-ink' : 'text-faint')}>
            <span className={cx('w-1.5 h-1.5 rounded-full', a.connected ? 'bg-positive' : 'bg-control')} />
            {a.platform === 'ga4' ? t('Google Analytics') : a.platform === 'gcal' ? t('Google Calendar') : a.platform === 'anthropic' ? t('IA (Claude)') : a.platform === 'storage' ? t('Almacenamiento') : PLATFORMS[a.platform].name}
          </a>
        ))}
      </div>

      <Section id="anthropic" title={t('IA · Claude')} account={acc('anthropic')}
        help={<>
          <p>{t('Genera el calendario, adapta los textos a cada red y escribe los artículos.')}</p>
          <p><span className="text-ink">{t('Mi suscripción:')}</span>{' '}{t('usa Claude Code, ya instalado en este equipo, con la cuenta con la que hayas iniciado sesión (Pro o Max). No necesita API key y el uso cuenta en los límites de tu plan.')}</p>
          <p><span className="text-ink">{t('API key:')}</span>{' '}{t('pago por uso. Crea una clave en')}{' '}<Link href="https://console.anthropic.com/settings/keys">{t('la consola de Anthropic')}</Link>.</p>
        </>}>
        <Segmented value={s.aiProvider} onChange={async (v) => {
          await api.settings.save({ aiProvider: v })
          reload()
        }} options={[{ value: 'claude-code', label: t('Mi suscripción (Claude Code)') }, { value: 'api', label: t('API key') }]} />
        {s.aiProvider === 'claude-code' ? (
          <ClaudeCodeStatusBox settings={s} onSaved={reload} />
        ) : (
          <SecretInput field="anthropicApiKey" label={t('API key')} status={st.anthropicApiKey} onSaved={reload} />
        )}
        <SettingInput k="anthropicModel" label={t('Modelo')} hint={t('Por defecto claude-opus-5-5')} settings={s} onSaved={reload} />
      </Section>

      <Section id="ga4" title={t('Google Analytics 4')} account={acc('ga4')}
        help={<>
          <p>{t('De aquí salen las visitas a tu web por canal y por campaña UTM, y las lecturas de cada artículo.')}</p>
          <ol className="list-decimal pl-4 flex flex-col gap-1">
            <li>{t('En')}{' '}<Link href="https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com">{t('Google Cloud')}</Link>{t(', activa «Google Analytics Data API».')}</li>
            <li>{t('Crea una cuenta de servicio y descarga su clave JSON.')}</li>
            <li>{t('En GA4 › Administrar › Gestión del acceso a la propiedad, añade el email de la cuenta de servicio como Lector.')}</li>
            <li>{t('Copia el ID de propiedad (Administrar › Detalles de la propiedad).')}</li>
          </ol>
        </>}
        connect={<ConnectButtons k="ga4" label={t('Probar y conectar')} ready={!!s.ga4PropertyId && st.ga4ServiceAccountJson} />}>
        <SettingInput k="ga4PropertyId" label={t('ID de propiedad')} placeholder="123456789" settings={s} onSaved={reload} />
        <SecretInput field="ga4ServiceAccountJson" label={t('Clave JSON de la cuenta de servicio')} multiline status={st.ga4ServiceAccountJson} onSaved={reload} />
        <Button size="sm" className="self-start" onClick={async () => {
          const txt = await api.app.readJson()
          if (txt) {
            await api.secrets.set('ga4ServiceAccountJson', txt)
            toast(t('Clave cargada y cifrada'), 'success')
            reload()
          }
        }}>{t('Cargar desde archivo .json')}</Button>
        <Err k="ga4" />
      </Section>

      <Section id="tiktok" title={t('TikTok')} mark={<PlatformDot platform="tiktok" size={10} />} account={acc('tiktok')}
        help={<>
          <p>{t('Crea una app en')}{' '}<Link href="https://developers.tiktok.com/apps">{t('TikTok for Developers')}</Link>{' '}{t('con Login Kit y Content Posting API (Direct Post), y los permisos user.info.basic, video.publish y video.list.')}</p>
          <RedirectNote />
          <p className="text-warning">{t('Hasta que TikTok audite tu app, los vídeos se publican en privado (solo tú los ves). Pide la auditoría desde el panel de la app.')}</p>
        </>}
        connect={<ConnectButtons k="tiktok" ready={st.tiktokClientKey && st.tiktokClientSecret} />}>
        <SecretInput field="tiktokClientKey" label={t('Client key')} status={st.tiktokClientKey} onSaved={reload} />
        <SecretInput field="tiktokClientSecret" label={t('Client secret')} status={st.tiktokClientSecret} onSaved={reload} />
        <label>
          <Label hint={t('Solo se usa si tu cuenta lo permite; si no, se publica en privado')}>{t('Privacidad al publicar')}</Label>
          <select className="field" value={s.tiktokPrivacy} onChange={async (e) => {
            await api.settings.save({ tiktokPrivacy: e.target.value })
            reload()
          }}>
            <option value="SELF_ONLY">{t('Privado (solo yo)')}</option>
            <option value="MUTUAL_FOLLOW_FRIENDS">{t('Amigos')}</option>
            <option value="FOLLOWER_OF_CREATOR">{t('Seguidores')}</option>
            <option value="PUBLIC_TO_EVERYONE">{t('Público')}</option>
          </select>
        </label>
        <Err k="tiktok" />
      </Section>

      <Section id="instagram" title={t('Instagram')} mark={<PlatformDot platform="instagram" size={10} />} account={acc('instagram')}
        help={<>
          <p>{t('Necesitas una cuenta profesional (Empresa o Creador). En')}{' '}<Link href="https://developers.facebook.com/apps">{t('Meta for Developers')}</Link>{' '}{t('crea una app de tipo Empresa, añade el producto Instagram › «API con inicio de sesión de Instagram», añade tu cuenta y pulsa «Generar token».')}</p>
          <p>{t('Permisos: instagram_business_basic, instagram_business_content_publish e instagram_business_manage_insights.')}</p>
          <p>{t('Instagram descarga el vídeo desde una URL pública: configura el almacenamiento más abajo o pega una URL en cada publicación.')}</p>
        </>}
        connect={<ConnectButtons k="instagram" label={t('Comprobar token')} ready={st.instagramAccessToken} />}>
        <SecretInput field="instagramAccessToken" label={t('Token de acceso')} hint={t('Se renueva solo cada 20 días')} status={st.instagramAccessToken} onSaved={reload} />
        <SettingInput k="igApiVersion" label={t('Versión de la Graph API')} settings={s} onSaved={reload} />
        <Err k="instagram" />
      </Section>

      <Section id="youtube" title={t('YouTube')} mark={<PlatformDot platform="youtube" size={10} />} account={acc('youtube')}
        help={<>
          <p>{t('En')}{' '}<Link href="https://console.cloud.google.com/apis/library/youtube.googleapis.com">{t('Google Cloud')}</Link>{' '}{t('activa YouTube Data API v3, configura la pantalla de consentimiento (añádete como usuario de prueba) y crea un ID de cliente OAuth de tipo «App de escritorio».')}</p>
          <p className="text-warning">{t('Google sube como privados los vídeos de proyectos sin verificar. Solicita la auditoría de la API para publicar en público.')}</p>
        </>}
        connect={<ConnectButtons k="youtube" ready={st.youtubeClientId && st.youtubeClientSecret} />}>
        <SecretInput field="youtubeClientId" label={t('Client ID')} status={st.youtubeClientId} onSaved={reload} />
        <SecretInput field="youtubeClientSecret" label={t('Client secret')} status={st.youtubeClientSecret} onSaved={reload} />
        <label>
          <Label>{t('Visibilidad al publicar')}</Label>
          <select className="field" value={s.youtubePrivacy} onChange={async (e) => {
            await api.settings.save({ youtubePrivacy: e.target.value as Settings['youtubePrivacy'] })
            reload()
          }}>
            <option value="public">{t('Público')}</option>
            <option value="unlisted">{t('Oculto')}</option>
            <option value="private">{t('Privado')}</option>
          </select>
        </label>
        <Err k="youtube" />
      </Section>

      <Section id="gcal" title={t('Google Calendar')} account={acc('gcal')}
        help={<>
          <p>{t('Vuelca el calendario de contenido a tu Google Calendar: un evento por publicación, con la red, el gancho, la palabra clave y un aviso 30 minutos antes. Se mantiene al día solo cuando cambias algo.')}</p>
          <p>{t('Usa el mismo cliente OAuth de Google que YouTube. En ese proyecto de Google Cloud activa también')}{' '}<Link href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com">{t('Google Calendar API')}</Link>.</p>
          <p>{t('¿Sin configurar nada? En Calendario › Exportar .ics descargas un archivo que puedes importar en Google Calendar.')}</p>
        </>}
        connect={<ConnectButtons k="gcal" ready={st.youtubeClientId && st.youtubeClientSecret} />}>
        {!(st.youtubeClientId && st.youtubeClientSecret) && <p className="text-[13px] text-muted">{t('Primero añade el Client ID y el Client secret de Google en la sección de YouTube.')}</p>}
        {acc('gcal')?.connected && <p className="text-[13px] text-muted">{t('Los eventos se crean en tu calendario principal.')}</p>}
        <Err k="gcal" />
      </Section>

      <Section id="linkedin" title={t('LinkedIn')} mark={<PlatformDot platform="linkedin" size={10} />} account={acc('linkedin')}
        help={<>
          <p>{t('En')}{' '}<Link href="https://www.linkedin.com/developers/apps">{t('LinkedIn Developers')}</Link>{' '}{t('crea una app (pide una página de empresa) y añade los productos «Sign In with LinkedIn using OpenID Connect» y «Share on LinkedIn». En Auth, añade la URL de redirección.')}</p>
          <RedirectNote />
          <p>{t('Publica en tu perfil personal. Las estadísticas por API requieren la Community Management API; mientras tanto, introdúcelas a mano en Analítica. El token dura 60 días.')}</p>
        </>}
        connect={<ConnectButtons k="linkedin" ready={st.linkedinClientId && st.linkedinClientSecret} />}>
        <SecretInput field="linkedinClientId" label={t('Client ID')} status={st.linkedinClientId} onSaved={reload} />
        <SecretInput field="linkedinClientSecret" label={t('Client secret')} status={st.linkedinClientSecret} onSaved={reload} />
        <SettingInput k="linkedinVersion" label={t('Versión de la API (AAAAMM)')} hint={t('Vacío: se usa la de hace dos meses')} placeholder={t('Automática')} settings={s} onSaved={reload} />
        <Err k="linkedin" />
      </Section>

      <Section id="x" title="X" mark={<PlatformDot platform="x" size={10} />} account={acc('x')}
        help={<>
          <p>{t('En')}{' '}<Link href="https://developer.x.com/en/portal/dashboard">{t('el portal de desarrolladores de X')}</Link>{t(', en la configuración de autenticación de tu app activa OAuth 2.0 (tipo «Native App» si no quieres secreto) con permisos de lectura y escritura, y añade la URL de redirección.')}</p>
          <RedirectNote />
          <p>{t('El plan gratuito permite publicar con límites bajos. Leer las impresiones de tus posts requiere un plan de pago.')}</p>
        </>}
        connect={<ConnectButtons k="x" ready={st.xClientId} />}>
        <SecretInput field="xClientId" label={t('Client ID (OAuth 2.0)')} status={st.xClientId} onSaved={reload} />
        <SecretInput field="xClientSecret" label={t('Client secret')} hint={t('Solo si tu app es de tipo Web App (cliente confidencial)')} status={st.xClientSecret} onSaved={reload} />
        <Err k="x" />
      </Section>

      <Section id="blog" title={t('Blog')} mark={<PlatformDot platform="blog" size={10} />} account={acc('blog')}
        help={<>
          <p><span className="text-ink">{t('WordPress:')}</span>{' '}{t('crea una contraseña de aplicación en Usuarios › Perfil › Contraseñas de aplicación.')}</p>
          <p><span className="text-ink">{t('Markdown:')}</span>{' '}{t('para webs con Astro, Hugo, Next o Jekyll. Cada artículo se guarda como .md en la carpeta de contenido; publícalo con tu flujo habitual (commit y despliegue).')}</p>
          <p>{t('Las lecturas de cada artículo se leen de Google Analytics por su ruta.')}</p>
        </>}
        connect={<ConnectButtons k="blog" label={t('Comprobar y conectar')} />}>
        <SettingInput k="website" label={t('URL de tu web')} hint={t('Base de los enlaces con UTM')} placeholder="https://tuweb.com" settings={s} onSaved={reload} />
        <Segmented value={s.blogMode} onChange={async (v) => {
          await api.settings.save({ blogMode: v })
          reload()
        }} options={[{ value: 'markdown', label: t('Archivos Markdown') }, { value: 'wordpress', label: t('WordPress') }]} />
        {s.blogMode === 'wordpress' ? (
          <>
            <SettingInput k="wordpressUrl" label={t('URL de WordPress')} placeholder="https://tuweb.com" settings={s} onSaved={reload} />
            <SettingInput k="wordpressUser" label={t('Usuario')} settings={s} onSaved={reload} />
            <SecretInput field="wordpressAppPassword" label={t('Contraseña de aplicación')} status={st.wordpressAppPassword} onSaved={reload} />
          </>
        ) : (
          <div>
            <Label>{t('Carpeta de artículos')}</Label>
            <div className="flex items-center gap-2">
              <Button onClick={async () => {
                const f = await api.app.pickFolder()
                if (f) {
                  await api.settings.save({ markdownFolder: f })
                  reload()
                }
              }}>{t('Elegir carpeta')}</Button>
              <span className="text-[13px] text-muted truncate">{s.markdownFolder || t('Ninguna')}</span>
            </div>
          </div>
        )}
        <Err k="blog" />
      </Section>

      <Section id="storage" title={t('Almacenamiento de archivos')} account={acc('storage')}
        help={<>
          <p>{t('Opcional. Instagram necesita el vídeo o la imagen en una URL pública. Si lo configuras, la app sube el archivo justo antes de publicar.')}</p>
          <p>{t('Vale cualquier almacenamiento compatible con S3. Con')}{' '}<Link href="https://developers.cloudflare.com/r2/buckets/public-buckets/">{t('Cloudflare R2')}</Link>{t(': crea un bucket con acceso público y un token de API S3. El endpoint es https://<cuenta>.r2.cloudflarestorage.com.')}</p>
        </>}>
        <SettingInput k="storageEndpoint" label={t('Endpoint S3')} placeholder="https://…r2.cloudflarestorage.com" settings={s} onSaved={reload} />
        <div className="grid grid-cols-2 gap-3">
          <SettingInput k="storageBucket" label={t('Bucket')} settings={s} onSaved={reload} />
          <SettingInput k="storageRegion" label={t('Región')} placeholder="auto" settings={s} onSaved={reload} />
        </div>
        <SettingInput k="storagePublicBaseUrl" label={t('URL pública del bucket')} placeholder="https://pub-….r2.dev" settings={s} onSaved={reload} />
        <SecretInput field="storageAccessKeyId" label={t('Access key ID')} status={st.storageAccessKeyId} onSaved={reload} />
        <SecretInput field="storageSecretAccessKey" label={t('Secret access key')} status={st.storageSecretAccessKey} onSaved={reload} />
      </Section>
    </div>
  )
}
