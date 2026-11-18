function normalizeKenyanPhoneNumber(value) {
  const digits = String(value || '').trim().replace(/\D/g, '');
  let normalized = '';
  if (/^0[17]\d{8}$/.test(digits)) normalized = `254${digits.slice(1)}`;
  else if (/^[17]\d{8}$/.test(digits)) normalized = `254${digits}`;
  else if (/^254[17]\d{8}$/.test(digits)) normalized = digits;
  return /^254[17]\d{8}$/.test(normalized) ? normalized : null;
}

// Shared account routing guards, admin passcode gate, and "My tickets" navigation.
(() => {
  const pageName = window.location.pathname.split('/').pop() || 'index.html';
  const adminPages = new Set(['dashboard.html', 'admin-approvals.html', 'admin-users.html']);
  const readSessionUser = () => {
    let storedUser;
    try { storedUser = localStorage.getItem('user'); } catch (_) { return null; }
    if (!storedUser) return null;
    try {
      const user = JSON.parse(storedUser);
      if (!user || typeof user !== 'object' || Array.isArray(user)) throw new Error('Invalid saved user');
      return user;
    } catch (_) {
      try { localStorage.removeItem('user'); } catch (_) { /* storage may be unavailable */ }
      return null;
    }
  };

  const sessionUser = readSessionUser();
  if (pageName === 'user-dashboard.html' && !sessionUser) {
    window.location.replace('login.html?redirect=user-dashboard.html');
  }

  window.adminAccessReady = false;
  window.adminFetch = async (url, options = {}) => {
    const headers = new Headers(options.headers || {});
    const adminToken = sessionStorage.getItem('twende_admin_token');
    if (adminToken) headers.set('x-admin-token', adminToken);
    const response = await fetch(url, { ...options, headers });
    if (response.status === 401 && adminPages.has(pageName) && adminToken) {
      sessionStorage.removeItem('twende_admin_token');
      window.location.reload();
    }
    return response;
  };

  if (adminPages.has(pageName)) {
    const adminShell = document.querySelector('.admin-shell');
    const accessModal = document.querySelector('#admin-access-modal');
    const accessForm = document.querySelector('#admin-access-form');
    const passcodeInput = document.querySelector('#admin-passcode');
    const errorMessage = document.querySelector('#admin-access-error');
    const showPasswordButton = document.querySelector('#toggle-admin-passcode');

    const unlockAdmin = () => {
      if (adminShell) adminShell.hidden = false;
      if (accessModal) accessModal.hidden = true;
      window.adminAccessReady = true;
      window.dispatchEvent(new CustomEvent('twende:admin-unlocked'));
    };

    if (sessionStorage.getItem('twende_admin_token')) unlockAdmin();

    showPasswordButton?.addEventListener('click', () => {
      if (!passcodeInput) return;
      const reveal = passcodeInput.type === 'password';
      passcodeInput.type = reveal ? 'text' : 'password';
      showPasswordButton.textContent = reveal ? 'Hide' : 'Show';
      showPasswordButton.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
      passcodeInput.focus();
    });

    accessForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!passcodeInput || !errorMessage) return;
      errorMessage.textContent = '';
      passcodeInput.classList.remove('is-invalid', 'is-shaking');
      const submit = accessForm.querySelector('[type="submit"]');
      if (submit) submit.disabled = true;
      try {
        const response = await fetch(`${API_BASE_URL}/api/admin/verify-passcode`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: passcodeInput.value })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.success || !data.adminToken) {
          throw new Error(data.message || 'Incorrect admin password');
        }
        sessionStorage.setItem('twende_admin_token', data.adminToken);
        passcodeInput.value = '';
        unlockAdmin();
      } catch (error) {
        errorMessage.textContent = error.message === 'Incorrect admin password' ? error.message : 'Unable to verify the passcode. Check your connection and try again.';
        passcodeInput.classList.add('is-invalid', 'is-shaking');
        passcodeInput.focus();
        window.setTimeout(() => passcodeInput.classList.remove('is-shaking'), 500);
      } finally {
        if (submit) submit.disabled = false;
      }
    });

    document.querySelectorAll('[data-lock-admin]').forEach((button) => {
      button.addEventListener('click', () => {
        sessionStorage.removeItem('twende_admin_token');
        window.location.reload();
      });
    });
  }

  document.addEventListener('click', (event) => {
    const ticketsLink = event.target.closest('[data-nav-my-tickets]');
    if (!ticketsLink) return;
    if (!readSessionUser()) {
      event.preventDefault();
      window.location.href = 'login.html?redirect=user-dashboard.html';
    }
  });
})();

const searchForm = document.querySelector('#event-search');
if (searchForm) {
  const queryInput = document.querySelector('#query');
  const citySelect = document.querySelector('#city');
  const dateSelect = document.querySelector('#date');
  const feedback = document.querySelector('#search-feedback');
  searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const params = { query: queryInput.value.trim(), city: citySelect.value || 'All cities', date: dateSelect.value || 'Any date' };
    console.log('Twende Events search:', params);
    const terms = [params.query && `“${params.query}”`, params.city, params.date].filter(Boolean);
    feedback.textContent = `Looking for ${terms.join(' · ')} events around Kisii.`;
  });
  [citySelect, dateSelect].forEach((select) => select.addEventListener('change', () => select.classList.add('has-selection')));
}

const menuToggle = document.querySelector('.menu-toggle');
const navLinks = document.querySelector('#primary-links');
const mobileDrawer = document.querySelector('#mobile-drawer');
const closeMobileDrawer = () => {
  if (!mobileDrawer || !menuToggle) return;
  mobileDrawer.classList.remove('open');
  mobileDrawer.setAttribute('aria-hidden', 'true');
  menuToggle.setAttribute('aria-expanded', 'false');
  menuToggle.setAttribute('aria-label', 'Open menu');
  document.body.classList.remove('mobile-drawer-open');
};
if (menuToggle && mobileDrawer) {
  const currentPage = window.location.pathname.split('/').pop() || 'index.html';
  mobileDrawer.querySelectorAll('.mobile-drawer-links a').forEach((link) => {
    if (link.getAttribute('href') === currentPage) {
      link.classList.add('active');
      link.setAttribute('aria-current', 'page');
    }
  });
  menuToggle.addEventListener('click', () => {
    const willOpen = !mobileDrawer.classList.contains('open');
    mobileDrawer.classList.toggle('open', willOpen);
    mobileDrawer.setAttribute('aria-hidden', String(!willOpen));
    menuToggle.setAttribute('aria-expanded', String(willOpen));
    menuToggle.setAttribute('aria-label', willOpen ? 'Close menu' : 'Open menu');
    document.body.classList.toggle('mobile-drawer-open', willOpen);
  });
  document.querySelector('#mobile-menu-close')?.addEventListener('click', closeMobileDrawer);
  mobileDrawer.addEventListener('click', (event) => {
    if (event.target.closest('[data-drawer-close]') || event.target.closest('a')) closeMobileDrawer();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMobileDrawer();
  });
} else if (menuToggle && navLinks) {
  menuToggle.addEventListener('click', () => {
    const expanded = menuToggle.getAttribute('aria-expanded') === 'true';
    menuToggle.setAttribute('aria-expanded', String(!expanded));
    menuToggle.setAttribute('aria-label', expanded ? 'Open navigation' : 'Close navigation');
    navLinks.classList.toggle('open', !expanded);
  });
  navLinks.addEventListener('click', (event) => {
    if (event.target.closest('a')) {
      menuToggle.setAttribute('aria-expanded', 'false');
      menuToggle.setAttribute('aria-label', 'Open navigation');
      navLinks.classList.remove('open');
    }
  });
}

const filterButtons = document.querySelectorAll('.filter-pill:not(.category-filter-btn)');
if (filterButtons.length) {
  const cards = document.querySelectorAll('.event-card');
  filterButtons.forEach((button) => button.addEventListener('click', () => {
    const filter = button.dataset.filter;
    filterButtons.forEach((item) => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    cards.forEach((card) => { card.hidden = filter !== 'all' && card.dataset.category !== filter; });
  }));
}

const checkoutCard = document.querySelector('.checkout-card');
if (checkoutCard) {
  const totalOutput = document.querySelector('#ticket-total');
  const checkoutFeedback = document.querySelector('#checkout-feedback');
  const getTicketTiers = () => [...checkoutCard.querySelectorAll('.ticket-tier')];
  const updateTotal = () => {
    let total = 0;
    getTicketTiers().forEach((tier) => {
      const quantity = Number(tier.querySelector('[data-quantity]').value || 0);
      total += quantity * Number(tier.dataset.price);
    });
    totalOutput.textContent = `KES ${total.toLocaleString('en-KE')}`;
    return total;
  };
  checkoutCard.addEventListener('click', (event) => {
    const button = event.target.closest('[data-quantity-change]');
    if (!button) return;
    const tier = button.closest('.ticket-tier');
    const output = tier?.querySelector('[data-quantity]');
    if (!output) return;
    output.value = String(Math.max(0, Number(output.value || 0) + Number(button.dataset.quantityChange)));
    updateTotal();
  });
  const buyTicketButton = document.querySelector('#buy-ticket-btn');
  buyTicketButton?.addEventListener('click', () => {
    let user = null;
    try { user = JSON.parse(localStorage.getItem('user') || 'null'); } catch (_) { /* treated as signed out */ }
    const eventId = new URLSearchParams(window.location.search).get('id');
    if (!user) {
      window.location.href = `login.html?redirect=${encodeURIComponent(`event-details.html?id=${eventId}`)}`;
      return;
    }
    if (!user.user_id || !eventId) {
      checkoutFeedback.textContent = 'Your account or event could not be identified. Please try again.';
      return;
    }

    const selectedTiers = getTicketTiers().map((tier) => ({
      tierId: Number(tier.dataset.tierId),
      tierName: tier.querySelector('.tier-info b')?.textContent.trim() || 'Ticket',
      quantity: Number(tier.querySelector('[data-quantity]')?.value || 0)
    })).filter((tier) => tier.quantity > 0);
    if (selectedTiers.length !== 1 || !Number.isSafeInteger(selectedTiers[0]?.tierId) || selectedTiers[0].tierId <= 0) {
      checkoutFeedback.textContent = selectedTiers.length > 1
        ? 'Please check out one ticket tier at a time.'
        : 'Choose a ticket tier before continuing.';
      return;
    }
    if (!user.full_name || !user.email) {
      checkoutFeedback.textContent = 'Add your name and email to your account before buying a ticket.';
      return;
    }

    const ticket = selectedTiers[0];
    const normalizedPhone = normalizeKenyanPhoneNumber(user.phone_number || user.phone);
    const localPhone = normalizedPhone ? normalizedPhone.slice(3) : '';
    const eventName = document.querySelector('#event-title')?.textContent.replace(/\s+/g, ' ').trim() || 'Twende Event';
    checkoutFeedback.textContent = '';
    window.twendeMpesaCheckout?.open({
      userId: Number(user.user_id),
      eventId: Number(eventId),
      tierId: ticket.tierId,
      tierName: `${ticket.tierName} × ${ticket.quantity}`,
      quantity: ticket.quantity,
      eventName,
      attendeeName: user.full_name,
      attendeeEmail: user.email,
      phone: localPhone
    });
  });
}

document.querySelectorAll('[data-download]').forEach((button) => button.addEventListener('click', () => {
  const ticket = button.closest('.digital-ticket, .wallet-ticket');
  const eventName = ticket.querySelector('h3').textContent;
  const infoRows = ticket.querySelectorAll('.ticket-info-row div, .wallet-event-data div');
  const details = [...infoRows].map((item) => `${item.querySelector('span').textContent}: ${item.querySelector('b').textContent}`).join(' | ');
  const venue = ticket.querySelector('.ticket-venue')?.textContent.trim() || [...infoRows].find((item) => item.querySelector('span').textContent === 'VENUE')?.querySelector('b').textContent || '';
  const ticketId = ticket.querySelector('.ticket-id, .wallet-ticket-id')?.textContent || '';
  const lines = [eventName, venue, details, ticketId];
  const escapePdfText = (value) => value.replace(/[^\x20-\x7E]/g, '').replace(/([\\()])/g, '\\$1');
  const commands = ['BT', '/F1 18 Tf', '54 740 Td', `(${escapePdfText(lines[0])}) Tj`, '/F1 10 Tf'];
  lines.slice(1).forEach((line) => commands.push('0 -26 Td', `(${escapePdfText(line)}) Tj`));
  commands.push('ET');
  const stream = commands.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${new TextEncoder().encode(stream).length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(new TextEncoder().encode(pdf).length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = new TextEncoder().encode(pdf).length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => { pdf += `${String(offset).padStart(10, '0')} 00000 n \n`; });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  const blob = new Blob([pdf], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${eventName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-ticket.pdf`;
  link.click();
  URL.revokeObjectURL(url);
}));

const faqHeaders = document.querySelectorAll('.faq-question');
faqHeaders.forEach((header) => {
  header.addEventListener('click', () => {
    const wasOpen = header.getAttribute('aria-expanded') === 'true';
    faqHeaders.forEach((item) => {
      const answer = document.getElementById(item.getAttribute('aria-controls'));
      item.setAttribute('aria-expanded', 'false');
      item.querySelector('.faq-plus').textContent = '+';
      if (answer) answer.hidden = true;
    });

    if (!wasOpen) {
      const answer = document.getElementById(header.getAttribute('aria-controls'));
      header.setAttribute('aria-expanded', 'true');
      header.querySelector('.faq-plus').textContent = '−';
      if (answer) answer.hidden = false;
    }
  });
});

const discoverSearch = document.querySelector('#discover-search');
if (discoverSearch) {
  const queryField = document.querySelector('#discover-query');
  const categoryField = document.querySelector('#discover-category');
  const searchFeedback = document.querySelector('#discover-feedback');
  discoverSearch.addEventListener('submit', (event) => {
    event.preventDefault();
    const query = queryField.value.trim().toLowerCase();
    const category = categoryField.value;
    let visibleCount = 0;
    const discoverCards = document.querySelectorAll('.discover-event-card');
    discoverCards.forEach((card) => {
      const matchesQuery = !query || card.textContent.toLowerCase().includes(query);
      const matchesCategory = !category || card.dataset.category === category;
      const show = matchesQuery && matchesCategory;
      card.hidden = !show;
      if (show) visibleCount += 1;
    });
    searchFeedback.textContent = visibleCount
      ? `Showing ${visibleCount} matching event${visibleCount === 1 ? '' : 's'}.`
      : 'No events match those filters. Try a different search.';
  });
}

document.querySelectorAll('[data-scroll]').forEach((button) => {
  button.addEventListener('click', () => {
    const track = document.getElementById(button.dataset.scroll);
    if (!track) return;
    const amount = Math.max(240, track.clientWidth * 0.8);
    track.scrollBy({ left: amount * Number(button.dataset.direction), behavior: 'smooth' });
  });
});

const ratingForm = document.querySelector('#rating-form');
if (ratingForm) {
  const ratingStars = [...ratingForm.querySelectorAll('.rating-star')];
  let selectedRating = 0;
  let hoveredRating = 0;

  const paintStars = (rating) => {
    ratingStars.forEach((star, index) => {
      const filled = index < rating;
      star.classList.toggle('is-filled', filled);
      star.textContent = filled ? '★' : '☆';
      star.setAttribute('aria-checked', String(index + 1 === selectedRating));
    });
  };

  ratingStars.forEach((star) => {
    const value = Number(star.dataset.rating);
    star.addEventListener('mouseenter', () => {
      hoveredRating = value;
      paintStars(hoveredRating);
    });
    star.addEventListener('focus', () => paintStars(value));
    star.addEventListener('click', () => {
      selectedRating = value;
      hoveredRating = 0;
      paintStars(selectedRating);
    });
  });

  const starsContainer = ratingForm.querySelector('.rating-stars');
  starsContainer.addEventListener('mouseleave', () => {
    hoveredRating = 0;
    paintStars(selectedRating);
  });
  starsContainer.addEventListener('focusout', (event) => {
    if (!starsContainer.contains(event.relatedTarget)) paintStars(selectedRating);
  });

  ratingForm.addEventListener('submit', (event) => {
    event.preventDefault();
    ratingForm.innerHTML = '<div class="rating-success" role="status"><span class="rating-success-icon" aria-hidden="true">✓</span><p>Thank you! Your feedback keeps Kisii moving.</p></div>';
  });
}

const authTabs = document.querySelectorAll('[data-auth-tab]');
if (authTabs.length) {
  const authPanels = document.querySelectorAll('[data-auth-panel]');
  const loginStatus = document.querySelector('#login-status');
  authTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const method = tab.dataset.authTab;
      authTabs.forEach((item) => {
        const active = item === tab;
        item.classList.toggle('active', active);
        item.setAttribute('aria-selected', String(active));
        item.tabIndex = active ? 0 : -1;
      });
      authPanels.forEach((panel) => { panel.hidden = panel.dataset.authPanel !== method; });
      loginStatus.textContent = '';
    });
  });

  document.querySelector('#login-form').addEventListener('submit', (event) => {
    event.preventDefault();
    loginStatus.textContent = 'Sign-in service is not connected yet.';
  });

  document.querySelectorAll('[data-social-login]').forEach((button) => {
    button.addEventListener('click', () => {
      loginStatus.textContent = `${button.dataset.socialLogin} sign-in is not connected yet.`;
    });
  });
}

const dashboardTabControls = document.querySelectorAll('[data-dashboard-tab]');
if (dashboardTabControls.length) {
  const dashboardPanels = document.querySelectorAll('[data-dashboard-panel]');
  dashboardTabControls.forEach((control) => {
    control.addEventListener('click', (event) => {
      const tabName = control.dataset.dashboardTab;
      if (control.tagName === 'A') event.preventDefault();
      dashboardPanels.forEach((panel) => { panel.hidden = panel.dataset.dashboardPanel !== tabName; });
      document.querySelectorAll('.account-menu-link[data-dashboard-tab]').forEach((item) => {
        const active = item === control;
        item.classList.toggle('active', active);
        if (active) item.setAttribute('aria-current', 'page');
        else item.removeAttribute('aria-current');
      });
      if (tabName === 'payments') document.querySelector('#dashboard-payments')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      else window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });
}
// Create Event page: flyer preview, repeatable ticket tiers, and form feedback.
(() => {
  const form = document.getElementById('event-builder-form');
  if (!form) return;

  const fileInput = document.getElementById('poster-upload');
  const uploadZone = document.getElementById('poster-upload-zone');
  const uploadNote = document.getElementById('poster-upload-note');
  const tiers = document.getElementById('ticket-tiers-container');
  const addTierButton = document.getElementById('add-ticket-tier');
  const status = document.getElementById('builder-form-status');
  let tierCount = tiers ? tiers.querySelectorAll('.ticket-tier-row').length : 0;

  if (fileInput && uploadZone) {
    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      if (!file.type.startsWith('image/')) {
        fileInput.value = '';
        if (uploadNote) uploadNote.textContent = 'Choose a PNG, JPG, or other image file.';
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        fileInput.value = '';
        if (uploadNote) uploadNote.textContent = 'That image is larger than 5MB. Choose a smaller file.';
        return;
      }

      const reader = new FileReader();
      reader.addEventListener('load', () => {
        uploadZone.replaceChildren();
        const preview = document.createElement('img');
        preview.className = 'poster-preview-image';
        preview.src = String(reader.result);
        preview.alt = `Preview of ${file.name}`;
        const caption = document.createElement('strong');
        caption.textContent = file.name;
        uploadZone.append(preview, caption);
        uploadZone.classList.add('has-preview');
        if (uploadNote) uploadNote.textContent = 'Poster preview ready. Click the image to choose a different file.';
      });
      reader.readAsDataURL(file);
    });
  }

  const makeField = (labelText, name, type, placeholder, minValue) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'builder-field';
    const id = `tier-${name.replace(/[^a-z]/gi, '')}-${tierCount}`;
    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = labelText;
    const input = document.createElement('input');
    input.id = id;
    input.name = name;
    input.type = type;
    input.placeholder = placeholder;
    input.required = true;
    if (type === 'number') {
      input.min = String(minValue);
      input.step = '1';
      input.value = name.includes('Price') ? '0' : '';
    }
    wrapper.append(label, input);
    return wrapper;
  };

  if (tiers && addTierButton) {
    addTierButton.addEventListener('click', () => {
      tierCount += 1;
      const row = document.createElement('div');
      row.className = 'ticket-tier-row';
      row.append(
        makeField('Ticket Name', 'ticketName[]', 'text', 'e.g., VIP', 0),
        makeField('Price (KES)', 'ticketPrice[]', 'number', '0', 0),
        makeField('Quantity Available', 'ticketQuantity[]', 'number', '500', 1)
      );
      const remove = document.createElement('button');
      remove.className = 'remove-tier-button';
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ticket tier ${tierCount}`);
      remove.textContent = '×';
      remove.addEventListener('click', () => row.remove());
      row.append(remove);
      tiers.append(row);
      row.querySelector('input')?.focus();
    });
  }

  const announce = (message, kind) => {
    if (!status) return;
    status.textContent = message;
    status.classList.remove('is-error', 'is-success');
    if (kind) status.classList.add(kind);
  };

  document.getElementById('save-event-draft')?.addEventListener('click', () => {
    const values = {};
    new FormData(form).forEach((value, key) => {
      if (key === 'poster') return;
      if (key in values) values[key] = Array.isArray(values[key]) ? [...values[key], value] : [values[key], value];
      else values[key] = value;
    });
    try {
      localStorage.setItem('twende-event-draft', JSON.stringify(values));
      announce('Draft saved on this device.', 'is-success');
    } catch (_) {
      announce('Draft could not be saved in this browser.', 'is-error');
    }
  });

})();

// Load event listings from the events API and render them into Discover grids.
async function loadEvents() {
  const trendingGrid = document.querySelector('#trending-track');
  if (!trendingGrid) return;

  const calendarList = document.querySelector('#calendar-list-container');
  const calendarRail = document.querySelector('#calendar-rail-events');
  const calendarRange = document.querySelector('#calendar-rail-range');
  const categoryGrids = [...document.querySelectorAll('.category-card-grid')];
  const grids = [trendingGrid, ...categoryGrids];

  // Clear every event target before loading so no stale listings can remain visible.
  grids.forEach((grid) => {
    grid.replaceChildren();
    grid.hidden = true;
  });
  if (calendarList) calendarList.innerHTML = '';
  if (calendarRail) calendarRail.innerHTML = '';

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);

  const safeImageUrl = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      if (/^https?:\/\//i.test(raw)) return apiAssetUrl(raw);
      const serverPath = raw.replace(/^file:\/\/\/[a-z]:/i, '').replace(/\\/g, '/');
      const url = new URL(serverPath.startsWith('/') ? serverPath : `/${serverPath}`, API_BASE_URL);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch (_) {
      return '';
    }
  };
  const categorySlug = (category) => {
    const value = String(category || '').toLowerCase();
    if (/music|festival|concert/.test(value)) return 'music';
    if (/comedy|stand.?up/.test(value)) return 'comedy';
    if (/brunch/.test(value)) return 'brunch';
    return 'events';
  };

  const formatStartTime = (value) => {
    if (!value) return { badgeDay: 'TBA', badgeMonth: '', readable: 'Date to be announced' };
    const raw = String(value);
    const normalized = raw.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/)
      ? raw.replace(' ', 'T')
      : raw;
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) return { badgeDay: 'TBA', badgeMonth: '', readable: 'Date to be announced' };
    const badgeDay = new Intl.DateTimeFormat('en-KE', { day: '2-digit' }).format(date);
    const badgeMonth = new Intl.DateTimeFormat('en-KE', { month: 'short' }).format(date).toUpperCase();
    const datePart = new Intl.DateTimeFormat('en-KE', { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
    const timePart = new Intl.DateTimeFormat('en-KE', { hour: 'numeric', minute: '2-digit' }).format(date).replace(/\s/g, ' ').toUpperCase();
    return { badgeDay, badgeMonth, readable: `${datePart} • ${timePart}`, date };
  };

  const renderCard = (event) => {
    const title = escapeHtml(event.title || 'Untitled event');
    const category = String(event.category || 'Events');
    const categoryLabel = escapeHtml(category.toUpperCase());
    const slug = categorySlug(category);
    const venue = escapeHtml(event.venue || event.city || 'Kisii County');
    const when = formatStartTime(event.start_time);
    const poster = safeImageUrl(event.poster_url);
    const imageMarkup = poster ? `<img src="${escapeHtml(poster)}" alt="${title}" loading="lazy" onerror="this.remove()">` : '';
    const eventId = event.event_id ?? event.id;
    const detailHref = eventId == null ? 'event-details.html' : `event-details.html?id=${encodeURIComponent(String(eventId))}`;
    const priceSource = event.starting_price ?? event.price ?? event.ticket_price ?? event.min_price;
    const priceValue = Number(priceSource);
    const price = priceSource == null || priceSource === ''
      ? 'Price TBA'
      : Number.isFinite(priceValue) ? `KES ${priceValue.toLocaleString('en-KE')}` : 'Price TBA';
    return `<a class="discover-event-card" href="${escapeHtml(detailHref)}" data-category="${slug}"><div class="discover-event-image">${imageMarkup}<span class="discover-date-badge"><b>${escapeHtml(when.badgeDay)}</b><small>${escapeHtml(when.badgeMonth)}</small></span></div><div class="discover-event-body"><span class="event-type">${categoryLabel}</span><h3>${title}</h3><p class="discover-event-datetime">${escapeHtml(when.readable)}</p><p>⌖ ${venue}</p><span class="discover-price">from <b>${escapeHtml(price)}</b></span></div></a>`;
  };

  const renderCalendarRow = (event, index) => {
    const title = escapeHtml(event.title || 'Untitled event');
    const category = escapeHtml(String(event.category || 'EVENT').toUpperCase());
    const venue = escapeHtml(event.venue || event.city || 'Kisii County');
    const when = formatStartTime(event.start_time);
    const image = safeImageUrl(event.poster_url);
    const eventId = event.event_id ?? event.id;
    const rowKey = eventId ?? `event-${index}`;
    const detailHref = eventId == null ? 'event-details.html' : `event-details.html?id=${encodeURIComponent(String(eventId))}`;
    const priceSource = event.starting_price ?? event.price ?? event.ticket_price ?? event.min_price;
    const priceValue = Number(priceSource);
    const price = priceSource == null || priceSource === '' ? 'Tickets' : Number.isFinite(priceValue) ? `from KES ${priceValue.toLocaleString('en-KE')}` : 'Tickets';
    const imageMarkup = image
      ? `<img src="${escapeHtml(image)}" alt="${title} event poster" loading="lazy" onerror="this.remove()">`
      : '<span class="upcoming-row-poster" aria-hidden="true"></span>';
    return `<a class="upcoming-row" id="upcoming-${escapeHtml(rowKey)}" href="${escapeHtml(detailHref)}">${imageMarkup}<div><span class="event-type">${category} · ${escapeHtml(when.badgeDay)} ${escapeHtml(when.badgeMonth)}</span><h3>${title}</h3><p>${venue}</p></div><strong>${escapeHtml(price)} <span>↗</span></strong></a>`;
  };

  const showGridError = (grid, message) => {
    grid.innerHTML = `<div class="discover-load-message" role="status"><strong>${escapeHtml(message)}</strong><button type="button" data-retry-events>Try again</button></div>`;
    grid.hidden = false;
  };

  try {
    const response = await fetch(API_BASE_URL + '/api/events');
    if (!response.ok) throw new Error(`Events request failed (${response.status})`);
    const events = await response.json();
    if (!Array.isArray(events)) throw new Error('The events endpoint did not return a list.');
    const approvedCount = document.querySelector('#discover-approved-count');
    if (approvedCount) approvedCount.innerHTML = `${events.length} event${events.length === 1 ? '' : 's'}<br>ready to book.`;

      if (calendarList) calendarList.innerHTML = '';
      grids.forEach((grid) => { grid.innerHTML = ''; });
    if (calendarList) {
      events.forEach((event, index) => calendarList.insertAdjacentHTML('beforeend', renderCalendarRow(event, index)));
      if (!events.length) calendarList.innerHTML = '<p class="discover-empty-message">No approved events available right now.</p>';
    }

    if (calendarRail) {
      calendarRail.innerHTML = '';
      const datedEvents = events.map((event, index) => ({ event, index, when: formatStartTime(event.start_time) }))
        .filter(({ when }) => when.badgeMonth);
      const monthLabels = [...new Set(datedEvents.map(({ when }) => when.badgeMonth))];
      if (calendarRange) calendarRange.textContent = monthLabels.length ? monthLabels.join(' — ') : 'Dates TBA';
      datedEvents.forEach(({ event, index, when }) => {
        const eventId = event.event_id ?? event.id;
        const rowKey = eventId ?? `event-${index}`;
        calendarRail.insertAdjacentHTML('beforeend', `<a href="#upcoming-${escapeHtml(rowKey)}"><b>${escapeHtml(when.badgeDay)}</b><span>${escapeHtml(when.badgeMonth)}</span></a>`);
      });
      if (!datedEvents.length) calendarRail.innerHTML = '<span class="calendar-rail-empty">No dated events</span>';
    }

    const trendingEvents = events.slice(0, 5);
    const generalEvents = events.filter((event) => /event|campus|brunch|party/i.test(String(event.category || '')));
    const otherEvents = events.filter((event) => !generalEvents.includes(event));
    const buckets = [trendingEvents, generalEvents, otherEvents];

      document.querySelectorAll('.mood-button').forEach((button) => {
        const mood = button.querySelector('b')?.textContent.trim().toLowerCase() || '';
        const slug = categorySlug(mood);
        const count = events.filter((event) => categorySlug(event.category) === slug).length;
        const countLabel = button.querySelector('small');
        if (countLabel) countLabel.textContent = `${count} upcoming`;
      });

    grids.forEach((grid, index) => {
      const entries = buckets[index] || [];
      grid.innerHTML = '';
      if (entries.length) grid.innerHTML = entries.map(renderCard).join('');
      else grid.innerHTML = '<p class="discover-empty-message">No approved events available right now.</p>';
      grid.hidden = false;
    });

    document.querySelectorAll('.category-events').forEach((section, index) => {
      const count = section.querySelector('.category-head > span');
      if (count) count.textContent = `${(buckets[index + 1] || []).length} event${(buckets[index + 1] || []).length === 1 ? '' : 's'}`;
    });
  } catch (error) {
    console.error('Unable to load Twende Events:', error);
    const approvedCount = document.querySelector('#discover-approved-count');
    if (approvedCount) approvedCount.textContent = 'Events unavailable.';
    document.querySelectorAll('.category-head > span').forEach((count) => { count.textContent = 'Events unavailable'; });
      if (calendarList) calendarList.innerHTML = '<p class="discover-empty-message">Approved events could not be loaded right now.</p>';
      document.querySelectorAll('.mood-button small').forEach((label) => { label.textContent = 'Events unavailable'; });
      if (calendarRail) {
        calendarRail.innerHTML = '<span class="calendar-rail-empty">Events unavailable</span>';
        if (calendarRange) calendarRange.textContent = 'Unavailable';
      }
    grids.forEach((grid) => showGridError(grid, 'Approved events could not be loaded right now.'));
  }

  document.querySelectorAll('[data-retry-events]').forEach((button) => {
    button.addEventListener('click', () => loadEvents());
  });
}

if (document.querySelector('#trending-track')) loadEvents();

// Load the four nearest events for the homepage Trending Now rail.
(() => {
  const container = document.querySelector('#trending-events-container');
  if (!container) return;

  const escapeHomeValue = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
  const parseHomeDate = (value) => {
    if (!value) return null;
    const raw = String(value);
    const date = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(raw) ? raw.replace(' ', 'T') : raw);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  const safeHomeImage = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      if (/^https?:\/\//i.test(raw)) return apiAssetUrl(raw);
      // Upload paths must resolve against Express, not the local file page origin.
      const serverPath = raw.replace(/^file:\/\/\/[a-z]:/i, '').replace(/\\/g, '/');
      const url = new URL(serverPath.startsWith('/') ? serverPath : `/${serverPath}`, API_BASE_URL);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch (_) {
      return '';
    }
  };
  const renderTrendingCard = (event) => {
    console.log('[Twende Events] event poster_url:', event.poster_url);
    const title = escapeHomeValue(event.title || 'Untitled event');
    const category = escapeHomeValue(String(event.category || 'Events').toUpperCase());
    const venue = escapeHomeValue(event.venue || event.city || 'Kisii County');
    const eventDate = parseHomeDate(event.start_time);
    const dateDay = eventDate ? new Intl.DateTimeFormat('en-KE', { day: '2-digit' }).format(eventDate) : 'TBA';
    const dateMonth = eventDate ? new Intl.DateTimeFormat('en-KE', { month: 'short' }).format(eventDate).toUpperCase() : '';
    const posterUrl = safeHomeImage(event.poster_url);
    const posterMarkup = posterUrl ? `<img src="${escapeHomeValue(posterUrl)}" alt="${title}" loading="lazy" onerror="this.remove()">` : '';
    const id = event.event_id ?? event.id;
    const href = id == null ? 'event-details.html' : `event-details.html?id=${encodeURIComponent(String(id))}`;
    return `<a class="event-card" href="${escapeHomeValue(href)}">
      <div class="event-image">${posterMarkup}<span class="event-date"><b>${dateDay}</b><small>${dateMonth}</small></span><span class="event-category">${category}</span></div>
      <div class="event-card-content"><h3>${title}</h3><p class="event-location"><span>⌖</span> ${venue}</p><div class="event-card-bottom"><span>${eventDate ? escapeHomeValue(new Intl.DateTimeFormat('en-KE', { day: 'numeric', month: 'short' }).format(eventDate)) : 'Date TBA'} · <b>Click to view tiers</b></span><span class="event-arrow">↗</span></div></div>
    </a>`;
  };

  const loadTrendingEvents = async () => {
    container.setAttribute('aria-busy', 'true');
    try {
      const response = await fetch(API_BASE_URL + '/api/events');
      if (!response.ok) throw new Error(`Events request failed (${response.status})`);
      const events = await response.json();
      if (!Array.isArray(events)) throw new Error('The events endpoint did not return an array.');

      const now = Date.now();
      const sorted = events.map((event, index) => ({ event, index, date: parseHomeDate(event.start_time) }));
      sorted.sort((a, b) => {
        const aUpcoming = a.date && a.date.getTime() >= now;
        const bUpcoming = b.date && b.date.getTime() >= now;
        if (aUpcoming && bUpcoming) return a.date - b.date;
        if (aUpcoming) return -1;
        if (bUpcoming) return 1;
        if (a.date && b.date) return b.date - a.date;
        if (a.date) return -1;
        if (b.date) return 1;
        return a.index - b.index;
      });
      const featured = sorted.slice(0, 4).map(({ event }) => event);
      container.innerHTML = '';
      container.innerHTML = featured.length
        ? featured.map(renderTrendingCard).join('')
        : '<p class="home-events-message" role="status">No approved events available right now.</p>';
    } catch (error) {
      console.error('Unable to load homepage events:', error);
      container.innerHTML = '';
      container.innerHTML = '<p class="home-events-message" role="status">Events could not be loaded right now. Please try again shortly.</p>';
    } finally {
      container.setAttribute('aria-busy', 'false');
    }
  };

  loadTrendingEvents();
})();

// Rotate published events through the homepage hero feature card.
let heroEvents = [];
let currentIndex = 0;

function updateHeroCard(animate = true) {
  const card = document.querySelector('#hero-rotating-card');
  if (!card || !heroEvents.length) return;

  const event = heroEvents[currentIndex];
  const escapeValue = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
  const parseDate = (value) => {
    if (!value) return null;
    const raw = String(value);
    const parsed = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(raw) ? raw.replace(' ', 'T') : raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };
  const date = parseDate(event.start_time);
  const formattedDate = date
    ? new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date).replace(/\//g, '.')
    : 'DATE TBA';
  let posterUrl = '';
  try {
    const rawPoster = String(event.poster_url || '').trim();
    if (/^https?:\/\//i.test(rawPoster)) posterUrl = apiAssetUrl(rawPoster);
    else if (rawPoster) {
      const serverPath = rawPoster.replace(/^file:\/\/\/[a-z]:/i, '').replace(/\\/g, '/');
      posterUrl = new URL(serverPath.startsWith('/') ? serverPath : `/${serverPath}`, API_BASE_URL).href;
    }
  } catch (_) { /* show the neutral poster background */ }
  const title = String(event.title || 'Featured event');
  const eventId = event.event_id ?? event.id;
  card.href = eventId == null ? 'discover.html' : `event-details.html?id=${encodeURIComponent(String(eventId))}`;
  card.setAttribute('aria-label', `Get tickets for ${title}`);
  card.setAttribute('aria-busy', 'false');

  const render = () => {
    const posterMarkup = posterUrl ? `<img src="${escapeValue(posterUrl)}" alt="${escapeValue(title)} event poster" onerror="this.remove()">` : '';
    card.innerHTML = `${posterMarkup}<div class="hero-promo-content"><span class="promo-card-top">TWENDE PRESENTS <b>LIVE · KISII</b></span><span class="promo-card-link">GET YOUR TICKETS <b>↗</b></span></div>`;
  };

  if (!animate || !card.childElementCount) {
    render();
    return;
  }
  card.classList.add('is-changing');
  window.setTimeout(() => {
    render();
    window.requestAnimationFrame(() => card.classList.remove('is-changing'));
  }, 160);
}

(() => {
  const card = document.querySelector('#hero-rotating-card');
  if (!card) return;
  card.innerHTML = '';
  fetch(API_BASE_URL + '/api/events')
    .then((response) => {
      if (!response.ok) throw new Error(`Events request failed (${response.status})`);
      return response.json();
    })
    .then((events) => {
      if (!Array.isArray(events)) throw new Error('The events endpoint did not return an array.');
      heroEvents = events;
      if (!heroEvents.length) {
        card.innerHTML = '';
        card.innerHTML = '<span class="hero-empty-state">No approved events available right now.</span>';
        card.removeAttribute('href');
        card.setAttribute('aria-label', 'No approved events available right now.');
        card.setAttribute('aria-busy', 'false');
        return;
      }
      currentIndex = 0;
      updateHeroCard(false);
      if (heroEvents.length > 1) {
        window.setInterval(() => {
          currentIndex = (currentIndex + 1) % heroEvents.length;
          updateHeroCard();
        }, 5000);
      }
    })
    .catch((error) => {
      console.error('Unable to load hero events:', error);
      card.innerHTML = '';
      card.innerHTML = '<span class="hero-empty-state">Approved events could not be loaded right now.</span>';
      card.removeAttribute('href');
      card.setAttribute('aria-busy', 'false');
    });
})();

// Dynamic Fresh on Twende Events grid and category filters.
let allFreshEvents = [];
const freshEventsContainer = document.querySelector('#fresh-events-container');

function renderFreshEvents(eventsToRender) {
  if (!freshEventsContainer) return;
  const escapeFreshValue = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
  const parseFreshDate = (value) => {
    if (!value) return null;
    const raw = String(value);
    const parsed = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(raw) ? raw.replace(' ', 'T') : raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };
  const cards = eventsToRender.map((event) => {
    const title = escapeFreshValue(event.title || 'Untitled event');
    const categoryText = String(event.category || 'Events');
    const category = escapeFreshValue(categoryText.toUpperCase());
    const venue = escapeFreshValue(event.venue || event.city || 'Kisii County');
    const date = parseFreshDate(event.start_time);
    const day = date ? new Intl.DateTimeFormat('en-KE', { day: '2-digit' }).format(date) : 'TBA';
    const month = date ? new Intl.DateTimeFormat('en-KE', { month: 'short' }).format(date).toUpperCase() : '';
    let image = '';
    try {
      const rawImage = String(event.poster_url || '').trim();
      if (/^https?:\/\//i.test(rawImage)) image = apiAssetUrl(rawImage);
      else if (rawImage) {
        const serverPath = rawImage.replace(/^file:\/\/\/[a-z]:/i, '').replace(/\\/g, '/');
        image = new URL(serverPath.startsWith('/') ? serverPath : `/${serverPath}`, API_BASE_URL).href;
      }
    } catch (_) { /* use the neutral poster background */ }
    const eventId = event.event_id ?? event.id;
    const href = eventId == null ? 'event-details.html' : `event-details.html?id=${encodeURIComponent(String(eventId))}`;
    const categoryData = escapeFreshValue(categoryText.toLowerCase());
    const imageMarkup = image ? `<img src="${escapeFreshValue(image)}" alt="${title}" loading="lazy" onerror="this.remove()">` : '';
    return `<a class="event-card" href="${escapeFreshValue(href)}" data-category="${categoryData}"><div class="event-image">${imageMarkup}<span class="event-date"><b>${day}</b><small>${month}</small></span><span class="event-category">${category}</span></div><div class="event-card-content"><h3>${title}</h3><p class="event-location"><span>⌖</span> ${venue}</p><div class="event-card-bottom"><span>From <b>Click to view tiers</b></span><span class="event-arrow">↗</span></div></div></a>`;
  });
  freshEventsContainer.innerHTML = '';
  freshEventsContainer.innerHTML = cards.length ? cards.join('') : '<p class="home-events-message" role="status">No approved events available right now.</p>';
  freshEventsContainer.setAttribute('aria-busy', 'false');
}

if (freshEventsContainer) {
  const freshFilterButtons = [...document.querySelectorAll('.category-filter-btn')];
  freshFilterButtons.forEach((button) => button.addEventListener('click', () => {
    freshFilterButtons.forEach((item) => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    const selectedCategory = String(button.dataset.category || 'all').trim().toLowerCase();
    const matchingEvents = selectedCategory === 'all'
      ? allFreshEvents
      : allFreshEvents.filter((event) => String(event.category || '').toLowerCase().includes(selectedCategory));
    renderFreshEvents(matchingEvents);
  }));

  fetch(API_BASE_URL + '/api/events')
    .then((response) => {
      if (!response.ok) throw new Error(`Events request failed (${response.status})`);
      return response.json();
    })
    .then((events) => {
      if (!Array.isArray(events)) throw new Error('The events endpoint did not return an array.');
      allFreshEvents = events;
      renderFreshEvents(allFreshEvents);
      const upcomingEvents = allFreshEvents.filter((event) => {
        const start = event.start_time ? new Date(String(event.start_time).replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2})?)$/, '$1T$2')) : null;
        return start && !Number.isNaN(start.getTime()) && start.getTime() >= Date.now();
      });
      document.querySelectorAll('.home-mood-card').forEach((card) => {
        const label = card.querySelector('b')?.textContent.trim().toLowerCase();
        const count = label === 'events'
          ? upcomingEvents.length
          : label === 'music festival'
            ? upcomingEvents.filter((event) => /music|festival|concert/i.test(String(event.category || ''))).length
            : label === 'comedy'
              ? upcomingEvents.filter((event) => /comedy|stand.?up/i.test(String(event.category || ''))).length
              : 0;
        const countLabel = card.querySelector('small');
        if (countLabel) countLabel.textContent = `${count} upcoming`;
      });
    })
    .catch((error) => {
      console.error('Unable to load fresh events:', error);
      freshEventsContainer.innerHTML = '';
      freshEventsContainer.innerHTML = '<p class="home-events-message" role="status">Fresh events could not be loaded right now.</p>';
      freshEventsContainer.setAttribute('aria-busy', 'false');
      document.querySelectorAll('.home-mood-card small').forEach((label) => { label.textContent = 'Events unavailable'; });
    });
}

// Show the dashboard's premium empty state when the ticket wallet has no tickets.
const ticketWallet = document.querySelector('.wallet-grid');
const ticketEmptyState = document.querySelector('#ticket-empty-state');
if (ticketWallet && ticketEmptyState && !ticketWallet.querySelector('.wallet-ticket')) {
  ticketWallet.hidden = true;
  ticketEmptyState.hidden = false;
}

// Hydrate an event details page when it is opened with ?id=<event id>.
async function loadEventDetails() {
  const detailsPage = document.querySelector('main.detail-page');
  if (!detailsPage) return;

  const eventId = new URLSearchParams(window.location.search).get('id');
  if (!eventId) return;

  const status = document.querySelector('#event-detail-status');
  const setStatus = (message, isError = false) => {
    if (!status) return;
    status.textContent = message;
    status.classList.remove('hidden');
    status.classList.toggle('is-error', isError);
  };
  setStatus('Loading event details…');
  detailsPage.classList.remove('event-load-error');

  const formatDateTime = (value) => {
    if (!value) return 'Date to be announced';
    const raw = String(value);
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(raw) ? raw.replace(' ', 'T') : raw;
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) return 'Date to be announced';
    const dateText = new Intl.DateTimeFormat('en-US', {
      weekday: 'long', month: 'short', day: 'numeric'
    }).format(date);
    const timeText = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric', minute: '2-digit'
    }).format(date);
    return `${dateText} • ${timeText}`;
  };

  try {
    const response = await fetch(`${API_BASE_URL}/api/events/${encodeURIComponent(eventId)}`);
    if (!response.ok) throw new Error(`Event request failed (${response.status})`);
    const event = await response.json();
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Invalid event data returned.');

    const title = String(event.title || 'Untitled event');
    const category = String(event.category || 'Event');
    const venue = String(event.venue || event.city || 'Kisii County');
    const city = String(event.city || 'Kisii County');
    const description = String(event.description || 'Event details will be announced soon.');

    const titleElement = document.querySelector('#event-title');
    if (titleElement) titleElement.textContent = title;
    const categoryElement = document.querySelector('#event-category');
    if (categoryElement) categoryElement.textContent = `${category.toUpperCase()} · LIVE IN ${city.toUpperCase()}`;
    const dateElement = document.querySelector('#event-date-time');
    if (dateElement) dateElement.textContent = formatDateTime(event.start_time);
    const venueElement = document.querySelector('#event-venue');
    if (venueElement) venueElement.textContent = venue;
    const addressElement = document.querySelector('#event-venue-address');
    if (addressElement) addressElement.textContent = `⌖  ${venue}, ${city}, Kenya`;
    const mapLabel = document.querySelector('#event-map-label');
    if (mapLabel) mapLabel.textContent = venue;
    const descriptionElement = document.querySelector('#event-description');
    if (descriptionElement) descriptionElement.textContent = description;

    let ticketContainer = document.querySelector('#event-ticket-tiers');
    if (!ticketContainer) {
      const checkout = document.querySelector('.checkout-card');
      if (checkout) {
        ticketContainer = document.createElement('div');
        ticketContainer.id = 'event-ticket-tiers';
        const totalRow = checkout.querySelector('.checkout-total');
        checkout.insertBefore(ticketContainer, totalRow || null);
        checkout.querySelectorAll('.ticket-tier').forEach((tier) => ticketContainer.append(tier));
      }
    }
    if (ticketContainer) {
      const escapeTicketText = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      })[character]);
      let ticketData = event.tickets ?? event.data?.tickets ?? event.event?.tickets ?? event.ticket_tiers;
      if (typeof ticketData === 'string') {
        try { ticketData = JSON.parse(ticketData); } catch (_) { ticketData = []; }
      }
      const tickets = Array.isArray(ticketData) ? ticketData : [];
      if (tickets.length) {
        ticketContainer.innerHTML = tickets.map((ticket) => {
          const name = String(ticket?.tier_name || ticket?.name || 'Ticket');
          const priceValue = Number(ticket?.price ?? 0);
          const price = Number.isFinite(priceValue) && priceValue >= 0 ? priceValue : 0;
          const formattedPrice = `KES ${price.toLocaleString('en-KE')}`;
          const safeName = escapeTicketText(name);
          const description = escapeTicketText(ticket?.description || 'General admission');
          const tierId = Number(ticket?.tier_id ?? ticket?.id);
          return `<div class="ticket-tier" data-tier-id="${Number.isSafeInteger(tierId) ? tierId : ''}" data-price="${price}"><div class="tier-info"><b>${safeName}</b><span>${description}</span><strong>${formattedPrice}</strong></div><div class="quantity-control"><button type="button" data-quantity-change="-1" aria-label="Remove one ${safeName} ticket">−</button><output data-quantity>0</output><button type="button" data-quantity-change="1" aria-label="Add one ${safeName} ticket">+</button></div></div>`;
        }).join('');
      } else if (!ticketContainer.textContent.trim()) {
        ticketContainer.innerHTML = '<p class="ticket-availability-message">Tickets will be available soon.</p>';
      }
      const totalOutput = document.querySelector('#ticket-total');
      if (totalOutput) totalOutput.textContent = 'KES 0';
    }

    const hero = document.querySelector('.detail-hero');
    if (hero) hero.setAttribute('aria-label', `${title} event`);
    const poster = document.querySelector('.detail-poster');
    if (poster) poster.setAttribute('aria-label', `${title} event poster`);
    const fallbackPosterUrl = 'https://images.unsplash.com/photo-1501386761578-eac5c94b800a?auto=format&fit=crop&w=900&q=85';
    let posterUrl = fallbackPosterUrl;
    if (event.poster_url) {
      try {
        posterUrl = apiAssetUrl(event.poster_url) || fallbackPosterUrl;
      } catch (_) {
        posterUrl = fallbackPosterUrl;
      }
    }
    const posterImage = document.querySelector('#event-poster-image');
    if (posterImage) {
      posterImage.alt = `${title} event poster`;
      posterImage.onerror = () => {
        posterImage.onerror = null;
        posterImage.src = fallbackPosterUrl;
      };
      posterImage.src = posterUrl;
    }
    const heroImage = document.querySelector('.detail-hero-image');
    if (heroImage) heroImage.style.backgroundImage = `url("${posterUrl}")`;
    if (status) status.classList.add('hidden');
  } catch (error) {
    console.error('Unable to load event details:', error);
    setStatus('We could not load this event. Please check your connection and try again.', true);
    detailsPage.classList.add('event-load-error');
  }
}

loadEventDetails();

// PayHero STK Push checkout and payment-status polling.
(() => {
  const modal = document.querySelector('#mpesa-modal');
  const form = document.querySelector('#mpesa-payment-form');
  if (!modal || !form) return;

  const stepOne = document.querySelector('#mpesa-step-1');
  const stepTwo = document.querySelector('#mpesa-step-2');
  const stepThree = document.querySelector('#mpesa-step-3');
  const countdown = document.querySelector('#mpesa-countdown');
  const progressMessage = document.querySelector('#mpesa-progress-message');
  const paymentError = document.querySelector('#mpesa-payment-error');
  const submitError = document.querySelector('#mpesa-submit-error');
  const spinner = document.querySelector('#mpesa-spinner');
  const waitTitle = document.querySelector('#mpesa-wait-title');
  const countdownLabel = document.querySelector('#mpesa-countdown-label');
  const payButton = document.querySelector('#mpesa-pay-button');
  const cancelButton = document.querySelector('#mpesa-cancel');
  const tryAgainButton = document.querySelector('#mpesa-try-again');
  let checkoutContext = null;
  let activePayment = null;
  let pollTimer = null;
  let elapsedSeconds = 0;
  let pollInProgress = false;

  const showStep = (step) => {
    [stepOne, stepTwo, stepThree].forEach((item) => item.classList.toggle('hidden', item !== step));
  };

  const closeModal = () => {
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('mpesa-modal-open');
  };

  const openModal = (context) => {
    if (context) checkoutContext = context;
    if (activePayment) {
      checkoutContext = activePayment.context;
      showStep(stepTwo);
    } else {
      showStep(stepOne);
      if (checkoutContext) {
        document.querySelector('#mpesa-event-name').textContent = checkoutContext.eventName;
        document.querySelector('#mpesa-ticket-tier').textContent = checkoutContext.tierName;
        const amount = Number(document.querySelector('#ticket-total')?.textContent.replace(/[^\d.]/g, '') || 0);
        const formattedAmount = `KES ${amount.toLocaleString('en-KE')}`;
        document.querySelector('#mpesa-total-amount').textContent = formattedAmount;
        payButton.textContent = `Pay ${formattedAmount}`;
        const phone = document.querySelector('#mpesa-phone');
        if (!phone.value && checkoutContext.phone) phone.value = checkoutContext.phone;
      }
      submitError.hidden = true;
      submitError.textContent = '';
    }
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('mpesa-modal-open');
    if (activePayment && !pollTimer) startPolling(activePayment.externalReference);
  };

  const stopPolling = () => {
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = null;
    pollInProgress = false;
  };

  const showPaymentFailure = (reason) => {
    stopPolling();
    activePayment = null;
    spinner.hidden = true;
    waitTitle.textContent = 'Payment not completed';
    progressMessage.textContent = 'Your M-Pesa payment did not go through.';
    paymentError.textContent = reason || 'The payment was cancelled or declined. You can try again.';
    paymentError.hidden = false;
    countdownLabel.hidden = true;
    tryAgainButton.hidden = false;
    showStep(stepTwo);
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('mpesa-modal-open');
  };

  const showPaymentSuccess = (paymentStatus) => {
    stopPolling();
    const receipt = paymentStatus.mpesaReceipt || 'Receipt pending';
    document.querySelector('#mpesa-receipt-code').textContent = receipt;
    const count = Array.isArray(paymentStatus.tickets) ? paymentStatus.tickets.length : checkoutContext?.quantity || 1;
    document.querySelector('#mpesa-success-message').textContent = `${count} ticket${count === 1 ? '' : 's'} issued and ready in your My Tickets dashboard.`;
    activePayment = null;
    if (modal.classList.contains('hidden')) {
      const feedback = document.querySelector('#checkout-feedback');
      if (feedback) feedback.textContent = `Payment received · M-Pesa receipt ${receipt}. Your ticket${count === 1 ? ' is' : 's are'} ready in My Tickets.`;
      return;
    }
    showStep(stepThree);
  };

  const startPolling = (externalReference) => {
    stopPolling();
    const pollingStartedAt = Date.now();
    elapsedSeconds = 0;
    pollInProgress = false;
    countdownLabel.hidden = false;
    tryAgainButton.hidden = true;
    paymentError.hidden = true;
    spinner.hidden = false;
    waitTitle.textContent = 'Check your phone...';
    countdown.textContent = '01:00';
    pollTimer = window.setInterval(async () => {
      if (!activePayment || activePayment.externalReference !== externalReference) return;
      elapsedSeconds = Math.floor((Date.now() - pollingStartedAt) / 1000);
      countdown.textContent = `00:${String(Math.max(0, 60 - elapsedSeconds)).padStart(2, '0')}`;
      if (elapsedSeconds >= 60) {
        stopPolling();
        spinner.hidden = true;
        waitTitle.textContent = 'Still waiting for confirmation';
        progressMessage.textContent = 'The payment is still pending. You can close this window and check My Tickets shortly.';
        countdownLabel.hidden = true;
        return;
      }
      if (pollInProgress) return;
      pollInProgress = true;
      try {
        const response = await fetch(`${API_BASE_URL}/api/payments/status/${encodeURIComponent(externalReference)}`);
        const result = await response.json().catch(() => ({}));
        if (response.ok && result.status === 'paid') {
          showPaymentSuccess(result);
          return;
        }
        if (response.ok && result.status === 'failed') {
          showPaymentFailure(result.failureReason || 'The payment was cancelled or declined.');
          return;
        }
      } catch (error) {
        console.warn('Payment status check failed; will retry:', error.message);
      } finally {
        pollInProgress = false;
      }
    }, 3000);
  };

  document.querySelector('#mpesa-close')?.addEventListener('click', closeModal);
  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeModal();
  });
  cancelButton?.addEventListener('click', closeModal);
  tryAgainButton?.addEventListener('click', () => {
    activePayment = null;
    stopPolling();
    paymentError.hidden = true;
    submitError.hidden = true;
    spinner.hidden = false;
    countdownLabel.hidden = false;
    tryAgainButton.hidden = true;
    showStep(stepOne);
    document.querySelector('#mpesa-phone')?.focus();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
  });

  window.twendeMpesaCheckout = { open: openModal };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    if (!checkoutContext || activePayment) return;
    submitError.hidden = true;
    submitError.textContent = '';
    const normalizedPhone = normalizeKenyanPhoneNumber(form.elements.phone.value);
    if (!normalizedPhone) {
      submitError.textContent = 'Enter a valid Kenyan number: 07XXXXXXXX, 01XXXXXXXX, or 254[17]XXXXXXXX.';
      submitError.hidden = false;
      return;
    }
    const localPhone = normalizedPhone.slice(3);
    payButton.disabled = true;
    payButton.setAttribute('aria-busy', 'true');
    waitTitle.textContent = 'Starting your payment...';
    progressMessage.textContent = 'Please wait while we send the M-Pesa prompt.';
    showStep(stepTwo);
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    try {
      const response = await fetch(`${API_BASE_URL}/api/payments/stk-push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: checkoutContext.userId,
          event_id: checkoutContext.eventId,
          tier_id: checkoutContext.tierId,
          quantity: checkoutContext.quantity,
          attendee_name: checkoutContext.attendeeName,
          attendee_email: checkoutContext.attendeeEmail,
          phone_number: normalizedPhone
        })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.success || !result.externalReference) {
        throw new Error(result.error || 'Could not start the M-Pesa payment. Please try again.');
      }
      activePayment = { externalReference: result.externalReference, context: checkoutContext };
      spinner.hidden = false;
      paymentError.hidden = true;
      progressMessage.textContent = `M-Pesa prompt sent to 0${localPhone.slice(0, 3)}••••••. Enter your M-Pesa PIN on your phone to complete payment.`;
      startPolling(result.externalReference);
    } catch (error) {
      showStep(stepOne);
      submitError.textContent = error.message || 'Could not start the M-Pesa payment. Please try again.';
      submitError.hidden = false;
    } finally {
      payButton.disabled = false;
      payButton.removeAttribute('aria-busy');
    }
  });
})();

// Publish the Create Event form to the local events API.
const createEventForm = document.querySelector('#event-builder-form');
const publishEventButton = createEventForm?.querySelector('button[type="submit"]');

if (createEventForm && publishEventButton) {
  createEventForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!createEventForm.reportValidity()) return;

    const formData = new FormData(createEventForm);
    formData.set('title', String(formData.get('eventName') || '').trim());
    formData.set('start_time', String(formData.get('startDate') || ''));
    formData.set('end_time', String(formData.get('endDate') || ''));
    formData.set('organizer_id', '1');
    formData.delete('eventName');
    formData.delete('startDate');
    formData.delete('endDate');

    const posterFile = createEventForm.querySelector('#poster-upload')?.files?.[0];
    formData.delete('poster');
    if (posterFile) formData.append('poster', posterFile);

    const ticketsArray = [...createEventForm.querySelectorAll('#ticket-tiers-container .ticket-tier-row')].map((row) => ({
      name: row.querySelector('[name="ticketName[]"]')?.value.trim() || '',
      price: Number(row.querySelector('[name="ticketPrice[]"]')?.value || 0),
      quantity: Number(row.querySelector('[name="ticketQuantity[]"]')?.value || 0)
    }));
    formData.append('tickets', JSON.stringify(ticketsArray));

    if (!formData.get('title') || !formData.get('start_time') || !formData.get('end_time')) {
      alert('Please enter an event title, start time, and end time.');
      return;
    }

    publishEventButton.disabled = true;
    try {
      const response = await fetch(API_BASE_URL + '/api/events', {
        method: 'POST',
        body: formData
      });

      if (response.status === 201) {
        alert('Event created successfully!');
        window.location.href = 'dashboard.html';
      } else {
        alert('Unable to create event. Please try again.');
      }
    } catch (error) {
      console.error('Create event request failed:', error);
      alert('Unable to create event. Please check your connection and try again.');
    } finally {
      publishEventButton.disabled = false;
    }
  });
}

// Admin dashboard data
async function deleteEvent(eventId) {
  if (!window.confirm('Are you sure you want to delete this event?')) return;
  try {
      const response = await window.adminFetch(`${API_BASE_URL}/api/events/${encodeURIComponent(eventId)}`, {
      method: 'DELETE'
    });
    if (!response.ok) throw new Error(`Delete request failed (${response.status})`);
    window.location.reload();
  } catch (error) {
    console.error('Unable to delete event:', error);
    window.alert('The event could not be deleted. Please try again.');
  }
}

(() => {
  const totalEventsEl = document.querySelector('#total-events');
  const eventsListEl = document.querySelector('#dashboard-events-list');
  if (!totalEventsEl || !eventsListEl) return;

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);

  const formatDashboardDate = (value) => {
    if (!value) return 'Date to be announced';
    const parsed = new Date(String(value).includes('T') ? value : String(value).replace(' ', 'T'));
    if (Number.isNaN(parsed.getTime())) return escapeHtml(value);
    return new Intl.DateTimeFormat('en-KE', {
      day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit'
    }).format(parsed);
  };

  const loadAdminDashboard = async () => {
    try {
      const response = await window.adminFetch(API_BASE_URL + '/api/admin/events');
      if (!response.ok) throw new Error(`Dashboard request failed (${response.status})`);
      const events = await response.json();
      if (!Array.isArray(events)) throw new Error('The admin events endpoint did not return a list.');

      totalEventsEl.textContent = events.length.toLocaleString('en-KE');
      if (events.length === 0) {
        eventsListEl.innerHTML = '<tr><td class="admin-table-message" colspan="6">No approved events are currently published.</td></tr>';
        return;
      }

      eventsListEl.innerHTML = events.map((event) => {
        const eventId = event.event_id ?? event.id ?? '—';
        const title = event.title || 'Untitled event';
        const venue = event.venue || 'Venue to be announced';
        const date = formatDashboardDate(event.start_time ?? event.date);
        const status = event.approval_status || event.status || 'Scheduled';
        return `<tr>
          <td><span class="admin-event-id">#${escapeHtml(eventId)}</span></td>
          <td><strong>${escapeHtml(title)}</strong></td>
          <td>${escapeHtml(venue)}</td>
          <td>${date}</td>
          <td><span class="admin-status-badge">${escapeHtml(status)}</span></td>
          <td><button class="admin-delete-event" type="button" data-event-id="${escapeHtml(eventId)}" onclick="deleteEvent(this.dataset.eventId)">Delete</button></td>
        </tr>`;
      }).join('');
    } catch (error) {
      console.error('Unable to load admin events:', error);
      totalEventsEl.textContent = '—';
      eventsListEl.innerHTML = '<tr><td class="admin-table-message is-error" colspan="6">Events could not be loaded. Please refresh to try again.</td></tr>';
    }
  };

  if (window.adminAccessReady) loadAdminDashboard();
  else window.addEventListener('twende:admin-unlocked', loadAdminDashboard, { once: true });
})();

async function deleteUser(userId) {
  if (!window.confirm('Are you sure you want to delete this user?')) return;
  try {
    const response = await window.adminFetch(`${API_BASE_URL}/api/admin/users/${encodeURIComponent(userId)}`, {
      method: 'DELETE'
    });
    if (!response.ok) throw new Error(`Delete request failed (${response.status})`);
    window.location.reload();
  } catch (error) {
    console.error('Unable to delete user:', error);
    window.alert('The user could not be deleted. Please try again.');
  }
}

// Registered users admin page
(() => {
  const usersTableBody = document.querySelector('#users-table-body');
  if (!usersTableBody) return;

  const escapeUserValue = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);

  const loadRegisteredUsers = async () => {
    try {
      const response = await window.adminFetch(API_BASE_URL + '/api/admin/users');
      if (!response.ok) throw new Error(`Users request failed (${response.status})`);
      const users = await response.json();

      if (!Array.isArray(users) || users.length === 0) {
        usersTableBody.innerHTML = '<tr><td class="admin-table-message" colspan="6">No registered users found.</td></tr>';
        return;
      }

      usersTableBody.innerHTML = users.map((user) => `<tr>
        <td><span class="admin-event-id">#${escapeUserValue(user.user_id ?? user.id ?? '—')}</span></td>
        <td><strong>${escapeUserValue(user.full_name || 'Name unavailable')}</strong></td>
        <td>${escapeUserValue(user.email || '—')}</td>
        <td>${escapeUserValue(user.phone_number || '—')}</td>
        <td><span class="admin-status-badge admin-role-badge">${escapeUserValue(user.role || 'user')}</span></td>
        <td><button class="admin-delete-event" type="button" data-user-id="${escapeUserValue(user.user_id ?? user.id ?? '')}" onclick="deleteUser(this.dataset.userId)">Delete</button></td>
      </tr>`).join('');
    } catch (error) {
      console.error('Unable to load registered users:', error);
      usersTableBody.innerHTML = '<tr><td class="admin-table-message is-error" colspan="6">Registered users could not be loaded. Please refresh to try again.</td></tr>';
    }
  };

  if (window.adminAccessReady) loadRegisteredUsers();
  else window.addEventListener('twende:admin-unlocked', loadRegisteredUsers, { once: true });
})();

// Phone and password login
(() => {
  const callingCodes = [
    '1','7','20','27','30','31','32','33','34','36','39','40','41','43','44','45','46','47','48','49',
    '51','52','53','54','55','56','57','58','60','61','62','63','64','65','66','81','82','84','86','90','91','92','93','94','95','98',
    '211','212','213','216','218','220','221','222','223','224','225','226','227','228','229',
    '230','231','232','233','234','235','236','237','238','239','240','241','242','243','244','245','246','247','248','249',
    '250','251','252','253','254','255','256','257','258','260','261','262','263','264','265','266','267','268','269',
    '290','291','297','298','299','350','351','352','353','354','355','356','357','358','359',
    '370','371','372','373','374','375','376','377','378','379','380','381','382','383','385','386','387','389',
    '420','421','423','500','501','502','503','504','505','506','507','508','509',
    '590','591','592','593','594','595','596','597','598','599','670','672','673','674','675','676','677','678','679','680','681','682','683','685','686','687','688','689','690','691','692',
    '800','808','850','852','853','855','856','870','878','880','881','882','883','886','888','960','961','962','963','964','965','966','967','968','970','971','972','973','974','975','976','977','979','992','993','994','995','996','998'
  ];
  document.querySelectorAll('[data-country-code-select]').forEach((select) => {
    if (select.options.length) return;
    const orderedCodes = ['254', ...callingCodes.filter((code) => code !== '254').sort((a, b) => Number(a) - Number(b))];
    select.innerHTML = orderedCodes.map((code) => `<option value="+${code}">${code === '254' ? '🇰🇪 ' : ''}+${code}</option>`).join('');
    select.value = '+254';
  });

  const loginForm = document.querySelector('#login-form');
  if (!loginForm || !document.body.classList.contains('login-page')) return;

  const identifierInput = loginForm.querySelector('[name="identifier"]');
  const passwordInput = loginForm.querySelector('[name="password"]');
  const countryCodeInput = loginForm.querySelector('#country-code');
  const statusMessage = loginForm.querySelector('#login-status');
  const submitButton = loginForm.querySelector('button[type="submit"]');

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    statusMessage.textContent = '';
    statusMessage.classList.remove('is-error', 'is-success');

    const rawIdentifier = identifierInput.value.trim();
    const identifier = rawIdentifier.includes('@')
      ? rawIdentifier
      : `${countryCodeInput?.value || '+254'}${rawIdentifier.replace(/\D/g, '').replace(/^0+/, '')}`;
    const password = passwordInput.value;

    if (!rawIdentifier || !password) {
      statusMessage.textContent = 'Enter your email or phone number and password.';
      statusMessage.classList.add('is-error');
      return;
    }

    submitButton.disabled = true;
    submitButton.setAttribute('aria-busy', 'true');
    try {
      const response = await fetch(API_BASE_URL + '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, password })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || data.error || 'Invalid phone number or password.');

      localStorage.setItem('user', JSON.stringify(data.user));
      const userRole = String(data.user.role || '').toLowerCase();
      const requestedRedirect = new URLSearchParams(window.location.search).get('redirect');
      const allowedRedirects = new Set([
        'index.html', 'discover.html', 'about.html', 'blog.html', 'contact.html',
        'event-details.html', 'user-dashboard.html', 'dashboard.html', 'admin-users.html',
        'admin-approvals.html', 'scanner.html', 'create-event.html', 'verify-ticket.html'
      ]);
      let safeRedirect = null;
      if (requestedRedirect && !requestedRedirect.startsWith('/') && !requestedRedirect.includes('\\')) {
        try {
          const candidate = new URL(requestedRedirect, window.location.href);
          const page = candidate.pathname.split('/').pop();
          const localPagePath = new URL(page, window.location.href).pathname;
          if (candidate.origin === window.location.origin && candidate.pathname === localPagePath && allowedRedirects.has(page)) {
            safeRedirect = `${page}${candidate.search}${candidate.hash}`;
          }
        } catch (_) { /* ignore malformed or external redirect targets */ }
      }
      const adminOnlyPages = new Set(['dashboard.html', 'admin-users.html', 'admin-approvals.html']);
      if (safeRedirect) {
        const redirectPage = safeRedirect.split(/[?#]/)[0];
        window.location.href = adminOnlyPages.has(redirectPage) && userRole !== 'admin'
          ? 'user-dashboard.html'
          : safeRedirect;
      } else {
        window.location.href = userRole === 'admin' ? 'dashboard.html' : 'user-dashboard.html';
      }
    } catch (error) {
      statusMessage.textContent = error.message || 'Unable to sign in. Please try again.';
      statusMessage.classList.add('is-error');
    } finally {
      submitButton.disabled = false;
      submitButton.removeAttribute('aria-busy');
    }
  });
})();

// Register a Twende Events account
(() => {
  const registerForm = document.querySelector('#register-form');
  if (!registerForm) return;
  const phoneInput = registerForm.querySelector('[name="phone_number"]');
  const countryCodeInput = registerForm.querySelector('#register-country-code');
  const statusMessage = registerForm.querySelector('#register-status');
  const submitButton = registerForm.querySelector('button[type="submit"]');

  registerForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    statusMessage.textContent = '';
    statusMessage.classList.remove('is-error', 'is-success');
    const localNumber = phoneInput.value.replace(/\D/g, '').replace(/^0+/, '');
    const payload = {
      full_name: registerForm.querySelector('[name="full_name"]').value.trim(),
      email: registerForm.querySelector('[name="email"]').value.trim(),
      phone_number: `${countryCodeInput?.value || '+254'}${localNumber}`,
      password: registerForm.querySelector('[name="password"]').value
    };

    if (!localNumber) {
      statusMessage.textContent = 'Enter a valid phone number.';
      statusMessage.classList.add('is-error');
      return;
    }

    submitButton.disabled = true;
    submitButton.setAttribute('aria-busy', 'true');
    try {
      const response = await fetch(API_BASE_URL + '/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await response.json().catch(() => ({}));
      if (response.status !== 201) throw new Error(data.message || data.error || 'Unable to create your account.');
      window.alert('Your account has been created successfully! You can now log in.');
      window.location.href = 'login.html';
    } catch (error) {
      statusMessage.textContent = error.message || 'Registration failed. Please try again.';
      statusMessage.classList.add('is-error');
    } finally {
      submitButton.disabled = false;
      submitButton.removeAttribute('aria-busy');
    }
  });
})();
