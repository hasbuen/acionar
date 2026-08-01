import { supabase } from './supabase.js';

const BACKEND_URL = 'https://acionar-backend.vercel.app';
const FINANCIAL_SESSION_KEY = 'acionar_financial_session_v1';

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
    try {
        const { data: sessionData } = await supabase.auth.getSession();
        let session = sessionData?.session || null;

        if (!session?.access_token) {
            const { data: refreshedData } = await supabase.auth.refreshSession().catch(() => ({}));
            if (refreshedData?.session) session = refreshedData.session;
        }

        if (session?.access_token) {
            return session.access_token;
        }
    } catch (_) {}

    const financialSession = readFinancialSession();
    if (financialSession?.token) return financialSession.token;

    const recoveredSession = await recoverSessionFromActiveProfessional().catch(() => null);
    if (recoveredSession?.access_token) return recoveredSession.access_token;

    const activeProf = JSON.parse(localStorage.getItem('active_professional') || 'null');
    if (activeProf?.id || activeProf?.email) {
        return `prof_session_${activeProf.id || activeProf.email}`;
    }

    const error = new Error('Confirme sua senha para continuar.');
    error.code = 'FINANCIAL_UNLOCK_REQUIRED';
    throw error;
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

export async function unlockFinancialSession(password) {
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

export function clearFinancialSession() {
    localStorage.removeItem(FINANCIAL_SESSION_KEY);
}

export async function fetchAsaasAccountStatus() {
    return backendFetch('/api/asaas/account/status');
}

export async function saveProfessionalPixKey(tipoChave, chavePix) {
    return backendFetch('/api/asaas/account/save-pix', {
        method: 'POST',
        body: JSON.stringify({ tipoChave, chavePix })
    });
}

export async function createAsaasCheckout({ agendamentoId, descontoCentavos = 0 }) {
    return backendFetch('/api/asaas/checkout', {
        method: 'POST',
        body: JSON.stringify({ agendamentoId, descontoCentavos })
    });
}

export async function refundAsaasPayment(pagamentoId) {
    return backendFetch('/api/asaas/refund', {
        method: 'POST',
        body: JSON.stringify({ pagamentoId })
    });
}

export async function saveAsaasPlatformFee({ profissionalId, percentual = 0, fixoCentavos = 0 }) {
    return backendFetch('/api/asaas/platform-fee', {
        method: 'POST',
        body: JSON.stringify({ profissionalId, percentual, fixoCentavos })
    });
}
