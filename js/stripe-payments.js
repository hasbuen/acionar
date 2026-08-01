import { supabase } from './supabase.js';

const BACKEND_URL = 'https://acionar-backend.vercel.app';
const FINANCIAL_SESSION_KEY = 'acionar_financial_session_v1';
let connectInstance = null;
let connectLoadPromise = null;

function readFinancialSession() {
    try {
        const session = JSON.parse(localStorage.getItem(FINANCIAL_SESSION_KEY) || 'null');
        const expiresAt = Date.parse(session?.expiresAt || '');
        if (session?.token && Number.isFinite(expiresAt) && expiresAt > Date.now() + 30000) {
            return session;
        }
    } catch (_) {}
    localStorage.removeItem(FINANCIAL_SESSION_KEY);
    return null;
}

function activeProfessionalEmail() {
    try {
        const professional = JSON.parse(localStorage.getItem('active_professional') || 'null');
        return String(professional?.email || '').trim().toLowerCase();
    } catch (_) {
        return '';
    }
}

async function recoverSessionFromActiveProfessional() {
    let professional = null;
    try {
        professional = JSON.parse(localStorage.getItem('active_professional') || 'null');
    } catch (_) {}

    const email = String(professional?.email || '').trim().toLowerCase();
    const password = String(professional?.senha_hash || '').trim();
    if (!email || !password || password === 'auth') return null;

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data?.session?.access_token) return null;
    return data.session;
}

async function accessToken() {
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    if (sessionError) throw sessionError;

    let session = sessionData?.session || null;

    // Em PWA/mobile o armazenamento pode entregar a sessao alguns instantes
    // antes da renovacao automatica terminar. Tenta renovar uma vez antes de
    // informar que o login realmente precisa ser refeito.
    if (!session?.access_token) {
        const { data: refreshedData, error: refreshError } = await supabase.auth.refreshSession();
        if (!refreshError) session = refreshedData?.session || null;
    }

    if (!session?.access_token) {
        const financialSession = readFinancialSession();
        if (financialSession?.token) return financialSession.token;
    }

    // O login profissional continua valido mesmo quando o armazenamento do
    // PWA perde a sessao do Supabase Auth. Reconstrua a sessao em segundo plano
    // sem tirar o usuario da tela de configuracoes.
    if (!session?.access_token) {
        session = await recoverSessionFromActiveProfessional();
    }

    if (!session?.access_token) {
        const error = new Error('Confirme sua senha para abrir seus dados de recebimento.');
        error.code = 'FINANCIAL_UNLOCK_REQUIRED';
        throw error;
    }

    return session.access_token;
}

async function backendFetch(path, options = {}) {
    const token = await accessToken();
    const response = await fetch(`${BACKEND_URL}${path}`, {
        ...options,
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(payload.error || 'Não foi possível concluir a operação.');
        error.code = payload.code;
        if (response.status === 401 && readFinancialSession()?.token === token) {
            localStorage.removeItem(FINANCIAL_SESSION_KEY);
            error.code = 'FINANCIAL_UNLOCK_REQUIRED';
            error.message = 'Confirme sua senha novamente para continuar.';
        }
        throw error;
    }
    return payload;
}

export async function unlockStripeFinancialSession(password) {
    const email = activeProfessionalEmail();
    if (!email) {
        const error = new Error('Profissional ativo não identificado neste aparelho.');
        error.code = 'ACTIVE_PROFESSIONAL_REQUIRED';
        throw error;
    }
    if (!String(password || '')) {
        const error = new Error('Informe sua senha.');
        error.code = 'CREDENTIALS_REQUIRED';
        throw error;
    }

    const response = await fetch(`${BACKEND_URL}/api/auth/professional-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.token) {
        const error = new Error(payload.error || 'Não foi possível confirmar sua senha.');
        error.code = payload.code;
        throw error;
    }

    localStorage.setItem(FINANCIAL_SESSION_KEY, JSON.stringify({
        token: payload.token,
        expiresAt: payload.expiresAt
    }));
    return payload;
}

export async function fetchStripeConnectStatus() {
    return backendFetch('/api/stripe/connect/status');
}

async function createAccountSession() {
    return backendFetch('/api/stripe/connect/session', { method: 'POST', body: '{}' });
}

function loadConnectJs() {
    if (window.StripeConnect?.init) return Promise.resolve(window.StripeConnect);
    if (connectLoadPromise) return connectLoadPromise;

    connectLoadPromise = new Promise((resolve, reject) => {
        window.StripeConnect = window.StripeConnect || {};
        window.StripeConnect.onLoad = () => resolve(window.StripeConnect);
        const existing = document.querySelector('script[data-acionar-stripe-connect]');
        if (existing) {
            existing.addEventListener('error', () => reject(new Error('Falha ao carregar o formulário seguro do Stripe.')), { once: true });
            return;
        }
        const script = document.createElement('script');
        script.src = 'https://connect-js.stripe.com/v1.0/connect.js';
        script.async = true;
        script.dataset.acionarStripeConnect = 'true';
        script.addEventListener('error', () => reject(new Error('Falha ao carregar o formulário seguro do Stripe.')), { once: true });
        document.head.appendChild(script);
    });
    return connectLoadPromise;
}

export async function mountStripeConnectOnboarding(container, { onExit, onLoadError } = {}) {
    if (!container) throw new Error('Área do cadastro financeiro não encontrada.');
    const firstSession = await createAccountSession();
    const StripeConnect = await loadConnectJs();
    let firstClientSecret = firstSession.clientSecret;

    if (!connectInstance) {
        connectInstance = StripeConnect.init({
            publishableKey: firstSession.publishableKey,
            locale: 'pt-BR',
            appearance: {
                overlays: 'dialog',
                variables: {
                    colorPrimary: '#2563eb',
                    borderRadius: '16px',
                    fontFamily: 'Inter, system-ui, sans-serif'
                }
            },
            fetchClientSecret: async () => {
                if (firstClientSecret) {
                    const secret = firstClientSecret;
                    firstClientSecret = null;
                    return secret;
                }
                const refreshed = await createAccountSession();
                return refreshed.clientSecret;
            }
        });
    }

    container.replaceChildren();
    const onboarding = connectInstance.create('account-onboarding');
    onboarding.setCollectionOptions({ fields: 'eventually_due', futureRequirements: 'include' });
    onboarding.setOnExit(() => onExit?.());
    onboarding.setOnLoadError((loadError) => onLoadError?.(loadError?.error));
    container.appendChild(onboarding);
    return firstSession.state;
}

export async function createStripeCheckout({ agendamentoId, descontoCentavos = 0 }) {
    const nonce = globalThis.crypto?.randomUUID?.()
        || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const idempotencyKey = `checkout-${agendamentoId}-${nonce}`;
    return backendFetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ agendamentoId, descontoCentavos })
    });
}

export async function refundStripePayment(pagamentoId) {
    return backendFetch('/api/stripe/refund', {
        method: 'POST',
        body: JSON.stringify({ pagamentoId })
    });
}

export async function saveStripePlatformFee({ profissionalId, percentual = 0, fixoCentavos = 0 }) {
    return backendFetch('/api/stripe/platform-fee', {
        method: 'POST',
        body: JSON.stringify({ profissionalId, percentual, fixoCentavos })
    });
}
