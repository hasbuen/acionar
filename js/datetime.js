export function parseDateInputValue(value) {
    if (!value) return null;
    const [year, month, day] = value.split('-').map(Number);
    if (!year || !month || !day) return null;
    return new Date(year, month - 1, day);
}

export function formatDateInputValue(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export function formatTimeInputValue(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '09:00';
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
}

export function addDaysToDateInput(dateValue, days) {
    const base = parseDateInputValue(dateValue);
    if (!base) return dateValue;
    const target = new Date(base.getFullYear(), base.getMonth(), base.getDate());
    const amount = Number(days || 0);
    target.setDate(target.getDate() + (amount > 0 ? amount + 1 : amount));
    return formatDateInputValue(target);
}

export function toLocalDateTimeISO(dateValue, timeValue) {
    const datePart = parseDateInputValue(dateValue);
    if (!datePart) return null;

    const [hours, minutes] = (timeValue || '09:00').split(':').map(Number);
    const d = new Date(datePart.getFullYear(), datePart.getMonth(), datePart.getDate(), hours, minutes, 0, 0);

    const pad = (n) => String(n).padStart(2, '0');
    const yyyy = d.getFullYear();
    const mm = pad(d.getMonth() + 1);
    const dd = pad(d.getDate());
    const hh = pad(d.getHours());
    const min = pad(d.getMinutes());

    const offsetMin = -d.getTimezoneOffset();
    const sign = offsetMin >= 0 ? '+' : '-';
    const absOffsetMin = Math.abs(offsetMin);
    const offsetHH = pad(Math.floor(absOffsetMin / 60));
    const offsetMM = pad(absOffsetMin % 60);

    return `${yyyy}-${mm}-${dd}T${hh}:${min}:00.000${sign}${offsetHH}:${offsetMM}`;
}

export function toLocalDateTimeISOFromDate(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(), 0, 0).toISOString();
}
