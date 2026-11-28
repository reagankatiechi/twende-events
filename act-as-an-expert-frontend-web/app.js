function normalizeKenyanPhoneNumber(value) {
  const digits = String(value || '').trim().replace(/\D/g, '');
  let normalized = '';
  if (/^0[17]\d{8}$/.test(digits)) normalized = `254${digits.slice(1)}`;
  else if (/^[17]\d{8}$/.test(digits)) normalized = `254${digits}`;
  else if (/^254[17]\d{8}$/.test(digits)) normalized = digits;
  return /^254[17]\d{8}$/.test(normalized) ? normalized : null;
}

// Keep the public-site navigation in sync with the saved session on every page.
function syncNavbarAuthState() {
  let user = null;
  try {
    user = JSON.parse(localStorage.getItem('user') || 'null');
  } catch (_) {
    user = null;
  }
  const token = user?.token || localStorage.getItem('token');
  if (!user || !token) return;

  const fullName = String(user.full_name || user.name || user.username || 'Twende User').trim();
  const words = fullName.split(/\s+/).filter(Boolean);
  const initials = (words.length > 1
    ? `${words[0][0]}${words[words.length - 1][0]}`
    : (words[0] || 'TE').slice(0, 2)).toUpperCase();

  const applyAvatar = (link, mobile = false) => {
    if (!link) return;
    link.href = 'user-dashboard.html';
    link.classList.remove('btn-signin', 'mobile-signin');
    link.classList.add('nav-user-avatar');
    if (mobile) link.classList.add('mobile-account-link');
    link.dataset.navAvatar = '';
    link.textContent = initials;
    link.title = fullName;
    link.setAttribute('aria-label', `${fullName} account`);
  };

  document.querySelectorAll('[data-nav-avatar]').forEach((link) => applyAvatar(link, link.classList.contains('mobile-account-link')));
  document.querySelectorAll('.btn-signin').forEach((link) => applyAvatar(link));
  document.querySelectorAll('.mobile-signin').forEach((link) => applyAvatar(link, true));

  const userDashboardNav = document.querySelector('.user-dashboard-nav');
  if (userDashboardNav && !userDashboardNav.querySelector('[data-nav-avatar]')) {
    const avatar = document.createElement('a');
    avatar.className = 'nav-user-avatar user-dashboard-nav-avatar';
    avatar.dataset.navAvatar = '';
    avatar.href = 'user-dashboard.html';
    avatar.textContent = initials;
    avatar.title = fullName;
    avatar.setAttribute('aria-label', `${fullName} account`);
    userDashboardNav.insertBefore(avatar, userDashboardNav.querySelector('#user-logout'));
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', syncNavbarAuthState, { once: true });
} else {
  syncNavbarAuthState();
}
window.addEventListener('pageshow', syncNavbarAuthState);

function getTwendeSession() {
  try {
    const user = JSON.parse(localStorage.getItem('user') || 'null');
    const token = user?.token || localStorage.getItem('token');
    return user && token ? { ...user, token } : null;
  } catch (_) { return null; }
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
    if (!user.token) {
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
      authToken: user.token,
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
      (card.closest('.discover-card-wrap') || card).hidden = !show;
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
    const saveButton = getTwendeSession() && eventId != null
      ? `<button class="event-save-button" type="button" data-save-event="${escapeHtml(eventId)}" aria-label="Save ${title}" aria-pressed="false" title="Save event">♡</button>`
      : '';
    return `<article class="discover-card-wrap">${saveButton}<a class="discover-event-card" href="${escapeHtml(detailHref)}" data-category="${slug}"><div class="discover-event-image">${imageMarkup}<span class="discover-date-badge"><b>${escapeHtml(when.badgeDay)}</b><small>${escapeHtml(when.badgeMonth)}</small></span></div><div class="discover-event-body"><span class="event-type">${categoryLabel}</span><h3>${title}</h3><p class="discover-event-datetime">${escapeHtml(when.readable)}</p><p>⌖ ${venue}</p><span class="discover-price">from <b>${escapeHtml(price)}</b></span></div></a></article>`;
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

    const sessionUser = getTwendeSession();
    const eventSaveHero = document.querySelector('.detail-hero');
    if (sessionUser && eventSaveHero && !eventSaveHero.querySelector('[data-save-event]')) {
      const saveButton = document.createElement('button');
      saveButton.type = 'button';
      saveButton.className = 'event-save-button event-save-detail';
      saveButton.dataset.saveEvent = String(event.event_id ?? event.id ?? eventId);
      saveButton.setAttribute('aria-pressed', 'false');
      saveButton.setAttribute('aria-label', `Save ${title}`);
      saveButton.title = 'Save event';
      saveButton.textContent = '♡ Save Event';
      eventSaveHero.appendChild(saveButton);
    }

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
  const goToTicketsButton = document.querySelector('#mpesa-go-tickets');
  let checkoutContext = null;
  let activePayment = null;
  let pollTimer = null;
  let pollingAttempts = 0;
  let pollInProgress = false;
  let successRedirectTimer = null;

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
    if (goToTicketsButton) goToTicketsButton.hidden = true;
    tryAgainButton.hidden = false;
    showStep(stepTwo);
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('mpesa-modal-open');
  };

  const showPaymentSuccess = (paymentStatus) => {
    stopPolling();
    if (successRedirectTimer) window.clearTimeout(successRedirectTimer);
    const receipt = paymentStatus.mpesaReceipt || 'Receipt pending';
    document.querySelector('#mpesa-receipt-code').textContent = receipt;
    document.querySelector('#mpesa-success-message').textContent = `M-Pesa Receipt: ${receipt} — Your QR tickets have been issued. Redirecting to My Tickets...`;
    document.querySelector('.mpesa-receipt-note')?.setAttribute('hidden', '');
    activePayment = null;
    const viewTicketLink = document.querySelector('.mpesa-view-ticket');
    if (viewTicketLink) {
      viewTicketLink.href = 'user-dashboard.html';
      viewTicketLink.textContent = 'View & Download Tickets';
    }
    showStep(stepThree);
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('mpesa-modal-open');
    successRedirectTimer = window.setTimeout(() => {
      window.location.href = 'user-dashboard.html';
    }, 2000);
  };

  const showPollingTimeout = () => {
    stopPolling();
    activePayment = null;
    spinner.hidden = true;
    waitTitle.textContent = 'Payment is still being verified';
    progressMessage.textContent = 'Payment is still being verified by M-Pesa. Check My Tickets in a moment—your tickets will appear automatically once confirmed.';
    countdownLabel.hidden = true;
    cancelButton.hidden = true;
    tryAgainButton.hidden = true;
    if (goToTicketsButton) goToTicketsButton.hidden = false;
    showStep(stepTwo);
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('mpesa-modal-open');
  };

  const startPolling = (externalReference) => {
    stopPolling();
    pollingAttempts = 0;
    pollInProgress = false;
    countdownLabel.hidden = false;
    cancelButton.hidden = false;
    if (goToTicketsButton) goToTicketsButton.hidden = true;
    tryAgainButton.hidden = true;
    paymentError.hidden = true;
    spinner.hidden = false;
    waitTitle.textContent = 'Confirming your payment';
    progressMessage.textContent = 'Confirming your M-Pesa payment...';
    countdown.textContent = '01:00';
    pollTimer = window.setInterval(async () => {
      if (!activePayment || activePayment.externalReference !== externalReference) return;
      if (pollInProgress) return;
      if (pollingAttempts >= 24) {
        showPollingTimeout();
        return;
      }
      pollingAttempts += 1;
      const remainingSeconds = Math.max(0, 60 - Math.ceil(pollingAttempts * 2.5));
      countdown.textContent = `00:${String(remainingSeconds).padStart(2, '0')}`;
      pollInProgress = true;
      try {
        const response = await fetch(`${API_BASE_URL}/api/payments/status/${encodeURIComponent(externalReference)}`, {
          headers: { Authorization: `Bearer ${activePayment.context.authToken}` }
        });
        const result = await response.json().catch(() => ({}));
        const paymentStates = [result.status, result.payment_status].map((value) => String(value || '').trim().toLowerCase());
        const paid = paymentStates.some((state) => ['paid', 'success', 'completed'].includes(state));
        const failed = paymentStates.some((state) => ['failed', 'cancelled', 'canceled', 'rejected', 'expired'].includes(state));
        if (response.ok && paid) {
          showPaymentSuccess(result);
          return;
        }
        if (response.ok && failed) {
          showPaymentFailure(result.failureReason || 'The payment was cancelled or declined.');
          return;
        }
      } catch (error) {
        console.warn('Payment status check failed; will retry:', error.message);
      } finally {
        pollInProgress = false;
        if (pollingAttempts >= 24 && activePayment?.externalReference === externalReference) showPollingTimeout();
      }
    }, 2500);
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
    cancelButton.hidden = false;
    if (goToTicketsButton) goToTicketsButton.hidden = true;
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
      let loggedInUser = null;
      try { loggedInUser = JSON.parse(localStorage.getItem('user') || 'null'); } catch (_) { /* require a fresh sign-in */ }
      const authToken = loggedInUser?.token || localStorage.getItem('token') || checkoutContext.authToken;
      const userId = loggedInUser?.user_id ?? checkoutContext.userId;
      const email = loggedInUser?.email || checkoutContext.attendeeEmail;
      if (!authToken || !userId) throw new Error('Please sign in again before starting checkout.');
      checkoutContext = { ...checkoutContext, authToken, userId: Number(userId), attendeeEmail: email };
      const response = await fetch(`${API_BASE_URL}/api/payments/stk-push`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({
          user_id: userId,
          email,
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
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || data.message || `Delete request failed (${response.status})`);
    }
    window.location.reload();
  } catch (error) {
    console.error('Unable to delete event:', error);
    window.alert(error.message || 'The event could not be deleted. Please try again.');
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
        eventsListEl.innerHTML = '<tr><td class="admin-table-message" colspan="7">No approved events are currently published.</td></tr>';
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

// Passcode-protected revenue analytics, attendee filtering, and CSV manifest export.
(() => {
  const analyticsRoot = document.querySelector('#sales-analytics');
  if (!analyticsRoot) return;

  const eventFilter = document.querySelector('#analytics-event-filter');
  const refreshButton = document.querySelector('#analytics-refresh');
  const exportButton = document.querySelector('#analytics-export');
  const searchInput = document.querySelector('#manifest-search');
  const tierBody = document.querySelector('#analytics-tiers-body');
  const attendeeBody = document.querySelector('#analytics-attendees-body');
  const feedback = document.querySelector('#analytics-feedback');
  const statusButtons = [...document.querySelectorAll('[data-manifest-status]')];
  let attendeeRows = [];
  let selectedStatus = 'all';

  const escapeAnalytics = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
  const numberValue = (value) => Number(value || 0).toLocaleString('en-KE');
  const kesValue = (value) => `KES ${Number(value || 0).toLocaleString('en-KE', { maximumFractionDigits: 2 })}`;
  const formatAnalyticsDate = (value) => {
    if (!value) return '—';
    const raw = String(value);
    const parsed = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(raw) ? raw.replace(' ', 'T') : raw);
    if (Number.isNaN(parsed.getTime())) return escapeAnalytics(raw);
    return new Intl.DateTimeFormat('en-KE', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(parsed);
  };

  const getFilteredAttendees = () => {
    const query = String(searchInput?.value || '').trim().toLowerCase();
    return attendeeRows.filter((row) => {
      const status = String(row.status || '').toLowerCase();
      const matchesStatus = selectedStatus === 'all' || status === selectedStatus;
      const haystack = [row.attendee_name, row.phone_number, row.ticket_code, row.mpesa_receipt, row.email]
        .join(' ').toLowerCase();
      return matchesStatus && (!query || haystack.includes(query));
    });
  };

  const renderAttendees = () => {
    const filtered = getFilteredAttendees();
    if (!filtered.length) {
      attendeeBody.innerHTML = `<tr><td colspan="8" class="analytics-empty">${attendeeRows.length ? 'No attendees match these filters.' : 'No issued tickets for this selection yet.'}</td></tr>`;
      return;
    }
    attendeeBody.innerHTML = filtered.map((row) => {
      const status = String(row.status || 'valid').toLowerCase();
      const badgeClass = status === 'used' ? 'is-used' : 'is-valid';
      return `<tr>
        <td><code class="manifest-ticket-code">${escapeAnalytics(row.ticket_code || '—')}</code></td>
        <td><strong>${escapeAnalytics(row.attendee_name || 'Guest Attendee')}</strong><small class="manifest-email">${escapeAnalytics(row.email || 'N/A')}</small></td>
        <td>${escapeAnalytics(row.phone_number || 'N/A')}</td>
        <td>${escapeAnalytics(row.event_title || 'Event unavailable')}</td>
        <td>${escapeAnalytics(row.tier_name || 'General')}</td>
        <td><code>${escapeAnalytics(row.mpesa_receipt || 'N/A')}</code></td>
        <td>${formatAnalyticsDate(row.purchase_date)}</td>
        <td><span class="manifest-status ${badgeClass}">${escapeAnalytics(status === 'used' ? 'Used' : 'Valid')}</span></td>
      </tr>`;
    }).join('');
  };

  const renderAnalytics = (data) => {
    const summary = data.summary || {};
    const issued = Number(summary.totalTicketsIssued || 0);
    const used = Number(summary.ticketsUsedCount || 0);
    const valid = Number(summary.ticketsValidCount || 0);
    const checkinRate = issued ? Math.round((used / issued) * 100) : 0;
    document.querySelector('#analytics-revenue').textContent = kesValue(summary.totalRevenueKes);
    document.querySelector('#analytics-tickets').textContent = numberValue(issued);
    document.querySelector('#analytics-orders-caption').textContent = `Across ${numberValue(summary.paidOrdersCount)} paid orders`;
    document.querySelector('#analytics-checkins').textContent = `${numberValue(used)} / ${numberValue(issued)}`;
    document.querySelector('#analytics-checkin-rate').textContent = `${checkinRate}% of issued tickets`;
    document.querySelector('#analytics-valid').textContent = numberValue(valid);

    const events = Array.isArray(data.events) ? data.events : [];
    const chosenEvent = eventFilter.value;
    eventFilter.innerHTML = '<option value="">All Events</option>' + events.map((event) =>
      `<option value="${escapeAnalytics(event.event_id)}">${escapeAnalytics(event.title || `Event #${event.event_id}`)}</option>`
    ).join('');
    eventFilter.value = events.some((event) => String(event.event_id) === chosenEvent) ? chosenEvent : '';

    const tiers = Array.isArray(data.tierBreakdown) ? data.tierBreakdown : [];
    tierBody.innerHTML = tiers.length ? tiers.map((tier) => {
      const remaining = tier.remaining_quantity == null ? null : Number(tier.remaining_quantity);
      const sold = Number(tier.tickets_sold || 0);
      const progress = remaining == null ? 0 : (sold + remaining ? Math.min(100, Math.round((sold / (sold + remaining)) * 100)) : 0);
      return `<tr>
        <td><strong>${escapeAnalytics(tier.event_title || 'Event unavailable')}</strong></td>
        <td>${escapeAnalytics(tier.tier_name || 'General')}</td>
        <td>${kesValue(tier.price)}</td>
        <td>${numberValue(sold)}</td>
        <td><div class="tier-stock-cell"><span>${remaining == null ? 'Unlimited' : numberValue(remaining)}</span><span class="tier-stock-track"><span style="width:${progress}%"></span></span></div></td>
        <td><strong>${kesValue(tier.revenue_kes)}</strong></td>
      </tr>`;
    }).join('') : '<tr><td colspan="6" class="analytics-empty">No ticket tiers are available for this selection.</td></tr>';

    attendeeRows = Array.isArray(data.attendees) ? data.attendees : [];
    renderAttendees();
  };

  const loadAnalytics = async () => {
    feedback.textContent = 'Loading current revenue and ticket data…';
    refreshButton.disabled = true;
    const query = eventFilter.value ? `?event_id=${encodeURIComponent(eventFilter.value)}` : '';
    try {
      const response = await window.adminFetch(`${API_BASE_URL}/api/admin/analytics${query}`);
      if (!response.ok) throw new Error(`Analytics request failed (${response.status})`);
      renderAnalytics(await response.json());
      feedback.textContent = `Updated ${new Intl.DateTimeFormat('en-KE', { hour: 'numeric', minute: '2-digit' }).format(new Date())}`;
    } catch (error) {
      console.error('Unable to load admin analytics:', error);
      feedback.textContent = 'Analytics could not be loaded. Refresh to try again.';
      tierBody.innerHTML = '<tr><td colspan="6" class="analytics-empty is-error">Analytics could not be loaded.</td></tr>';
      attendeeBody.innerHTML = '<tr><td colspan="8" class="analytics-empty is-error">The attendee manifest could not be loaded.</td></tr>';
    } finally {
      refreshButton.disabled = false;
    }
  };

  refreshButton.addEventListener('click', loadAnalytics);
  eventFilter.addEventListener('change', loadAnalytics);
  searchInput.addEventListener('input', renderAttendees);
  statusButtons.forEach((button) => button.addEventListener('click', () => {
    selectedStatus = button.dataset.manifestStatus;
    statusButtons.forEach((item) => {
      const active = item === button;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    renderAttendees();
  }));
  exportButton.addEventListener('click', () => {
    const columns = ['Ticket Code', 'Attendee Name', 'Phone Number', 'Email', 'Event', 'Tier', 'M-Pesa Receipt', 'Purchase Date', 'Status'];
    const quoteCsv = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const rows = getFilteredAttendees().map((row) => [
      row.ticket_code, row.attendee_name, row.phone_number, row.email, row.event_title,
      row.tier_name, row.mpesa_receipt, row.purchase_date, row.status
    ]);
    const csv = [columns, ...rows].map((row) => row.map(quoteCsv).join(',')).join('\r\n');
    const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = `twende-events-manifest-${new Date().toLocaleDateString('sv-SE')}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
  });

  if (window.adminAccessReady) loadAnalytics();
  else window.addEventListener('twende:admin-unlocked', loadAnalytics, { once: true });
})();

// Public contact form submission.
(() => {
  const form = document.querySelector('#contact-inquiry-form');
  if (!form) return;
  const feedback = document.querySelector('#contact-form-status');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) {
      feedback.textContent = 'Please complete your name, email, topic, and message.';
      feedback.className = 'contact-form-status is-error';
      return;
    }
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    feedback.textContent = 'Sending your note…';
    feedback.className = 'contact-form-status is-info';
    const payload = {
      full_name: form.elements.name.value.trim(),
      email: form.elements.email.value.trim(),
      topic: form.elements.topic.value.trim(),
      order_reference: form.elements.order_reference.value.trim(),
      message: form.elements.message.value.trim()
    };
    try {
      const response = await fetch(`${API_BASE_URL}/api/contact`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || data.message || 'Your note could not be sent. Please try again.');
      form.reset();
      feedback.textContent = 'Thanks! Your note has been sent to the Twende Events team.';
      feedback.className = 'contact-form-status is-success';
    } catch (error) {
      feedback.textContent = error.message || 'Your note could not be sent. Please try again.';
      feedback.className = 'contact-form-status is-error';
    } finally { submit.disabled = false; }
  });
})();

// Responsive admin drawer is shared by the dashboard and users directory.
(() => {
  const shell = document.querySelector('.admin-shell');
  const backdrop = document.querySelector('[data-admin-sidebar-close]');
  const toggle = document.querySelector('[data-admin-sidebar-toggle]');
  if (!shell || !backdrop || !toggle) return;
  const close = () => {
    shell.classList.remove('is-sidebar-open');
    document.body.classList.remove('admin-sidebar-open');
    backdrop.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open navigation');
  };
  toggle.addEventListener('click', () => {
    const open = !shell.classList.contains('is-sidebar-open');
    shell.classList.toggle('is-sidebar-open', open);
    document.body.classList.toggle('admin-sidebar-open', open);
    backdrop.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
    if (open) shell.querySelector('.admin-sidebar .admin-nav-link')?.focus();
  });
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
})();

// Pending event moderation is part of the same passcode-protected admin workspace.
(() => {
  const pendingBody = document.querySelector('#pending-events-table-body');
  const approvalView = document.querySelector('[data-admin-panel="approvals"]');
  if (!pendingBody || !approvalView) return;

  let pendingEventsData = [];
  const reviewModal = document.querySelector('#review-modal');
  const editModal = document.querySelector('#approval-edit-modal');
  const editForm = document.querySelector('#approval-edit-form');
  const feedback = document.querySelector('#pending-events-feedback');
  const escapeApproval = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const approvalDate = (value) => {
    if (!value) return 'Date to be announced';
    const raw = String(value);
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(raw) ? raw.replace(' ', 'T') : raw;
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? escapeApproval(raw) : new Intl.DateTimeFormat('en-KE', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
  };
  const setModalOpen = (modal, open) => {
    modal.hidden = !open;
    modal.classList.toggle('is-open', open);
    modal.setAttribute('aria-hidden', String(!open));
    document.body.classList.toggle('review-modal-open', Boolean(document.querySelector('.review-modal.is-open')));
  };
  const findPending = (id) => pendingEventsData.find((item) => String(item.event_id ?? item.id) === String(id));

  async function loadPendingEvents() {
    if (!window.adminAccessReady) return;
    if (feedback) feedback.textContent = 'Loading pending submissions…';
    pendingBody.innerHTML = '<tr><td colspan="6" class="admin-table-message">Loading pending events…</td></tr>';
    try {
      const response = await window.adminFetch(`${API_BASE_URL}/api/admin/events/pending`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || payload.message || `Pending events request failed (${response.status})`);
      pendingEventsData = Array.isArray(payload) ? payload : (Array.isArray(payload.events) ? payload.events : []);
      if (!pendingEventsData.length) {
        pendingBody.innerHTML = '<tr><td colspan="6" class="admin-table-message">There are no events waiting for approval.</td></tr>';
      } else {
        pendingBody.innerHTML = pendingEventsData.map((item) => {
          const id = item.event_id ?? item.id;
          return `<tr><td><span class="admin-event-id">#${escapeApproval(id || '—')}</span></td><td><strong>${escapeApproval(item.title || 'Untitled event')}</strong></td><td>${escapeApproval(item.category || '—')}</td><td>${escapeApproval(item.venue || 'Venue to be announced')}</td><td>${approvalDate(item.start_time)}</td><td><div class="admin-approval-actions"><button class="admin-review-event" type="button" data-review-event="${escapeApproval(id)}">Review</button><button class="admin-edit-event" type="button" data-edit-approval="${escapeApproval(id)}">Edit</button><button class="admin-approve-event" type="button" data-approve-event="${escapeApproval(id)}">Approve</button><button class="admin-reject-event" type="button" data-reject-event="${escapeApproval(id)}">Reject</button></div></td></tr>`;
        }).join('');
      }
      if (feedback) feedback.textContent = `${pendingEventsData.length} pending submission${pendingEventsData.length === 1 ? '' : 's'}.`;
    } catch (error) {
      console.error('Unable to load pending events:', error);
      pendingEventsData = [];
      pendingBody.innerHTML = '<tr><td colspan="6" class="admin-table-message is-error">Pending events could not be loaded. Please refresh to try again.</td></tr>';
      if (feedback) feedback.textContent = error.message || 'Pending events could not be loaded.';
    }
  }
  window.loadPendingEvents = loadPendingEvents;
  document.querySelector('#pending-events-refresh')?.addEventListener('click', loadPendingEvents);

  const openReview = (item) => {
    const image = document.querySelector('#review-event-poster');
    const rawPoster = String(item.poster_url || '').trim().replace(/^file:\/\/\/[a-z]:/i, '').replace(/\\/g, '/');
    image.src = apiAssetUrl(rawPoster) || 'https://placehold.co/960x540?text=Event+Poster';
    image.alt = `${item.title || 'Event'} poster`;
    document.querySelector('#review-event-title').textContent = item.title || 'Untitled event';
    document.querySelector('#review-event-category').textContent = item.category || 'Category not provided';
    document.querySelector('#review-event-venue').textContent = item.venue || 'Venue to be announced';
    document.querySelector('#review-event-start').textContent = approvalDate(item.start_time);
    document.querySelector('#review-event-description').textContent = item.description || 'No description provided.';
    document.querySelector('#review-organizer-name').textContent = item.organizer_name || 'Not provided';
    document.querySelector('#review-organizer-email').textContent = item.organizer_email || 'Not provided';
    setModalOpen(reviewModal, true);
    reviewModal.querySelector('.review-modal-close')?.focus();
  };
  const closeReview = () => setModalOpen(reviewModal, false);
  const closeEdit = () => setModalOpen(editModal, false);
  document.querySelector('[data-close-review]')?.addEventListener('click', closeReview);
  document.querySelectorAll('[data-close-approval-edit]').forEach((button) => button.addEventListener('click', closeEdit));
  [reviewModal, editModal].forEach((modal) => modal?.addEventListener('click', (event) => { if (event.target === modal) setModalOpen(modal, false); }));

  pendingBody.addEventListener('click', async (event) => {
    const reviewButton = event.target.closest('[data-review-event]');
    const editButton = event.target.closest('[data-edit-approval]');
    const approveButton = event.target.closest('[data-approve-event]');
    const rejectButton = event.target.closest('[data-reject-event]');
    const button = reviewButton || editButton || approveButton || rejectButton;
    if (!button) return;
    const id = button.dataset.reviewEvent || button.dataset.editApproval || button.dataset.approveEvent || button.dataset.rejectEvent;
    const item = findPending(id);
    if (!item) return;
    if (reviewButton) { openReview(item); return; }
    if (editButton) {
      document.querySelector('#approval-edit-id').value = item.event_id ?? item.id;
      document.querySelector('#approval-edit-name').value = item.title || '';
      const category = document.querySelector('#approval-edit-category');
      if (item.category && !Array.from(category.options).some((option) => option.value === item.category)) category.add(new Option(item.category, item.category));
      category.value = item.category || '';
      document.querySelector('#approval-edit-venue').value = item.venue || '';
      const date = item.start_time ? new Date(String(item.start_time).replace(' ', 'T')) : null;
      document.querySelector('#approval-edit-start').value = date && !Number.isNaN(date.getTime()) ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
      document.querySelector('#approval-edit-description').value = item.description || '';
      setModalOpen(editModal, true);
      document.querySelector('#approval-edit-name').focus();
      return;
    }
    const action = approveButton ? 'approve' : 'reject';
    const confirmText = action === 'approve' ? 'Are you sure you want to approve this event and push it live?' : 'Are you sure you want to reject and delete this event submission?';
    if (!window.confirm(confirmText)) return;
    button.disabled = true;
    try {
      const response = await window.adminFetch(`${API_BASE_URL}/api/admin/events/${encodeURIComponent(id)}/${action === 'approve' ? 'approve' : 'reject'}`, { method: action === 'approve' ? 'PUT' : 'DELETE' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || data.error || `Could not ${action} the event.`);
      await loadPendingEvents();
    } catch (error) {
      window.alert(error.message || `Could not ${action} the event.`);
      button.disabled = false;
    }
  });

  editForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!editForm.reportValidity()) return;
    const submit = editForm.querySelector('[type="submit"]');
    submit.disabled = true;
    const id = editForm.elements.event_id.value;
    const body = { title: editForm.elements.title.value.trim(), category: editForm.elements.category.value, venue: editForm.elements.venue.value.trim(), start_time: editForm.elements.start_time.value, description: editForm.elements.description.value.trim() };
    try {
      const response = await window.adminFetch(`${API_BASE_URL}/api/admin/events/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || data.message || 'The event could not be updated.');
      closeEdit();
      await loadPendingEvents();
    } catch (error) { window.alert(error.message || 'The event could not be updated.'); }
    finally { submit.disabled = false; }
  });
})();

// Single-view admin workspace: analytics, events, approvals, reconciliation, and support.
(() => {
  const root = document.querySelector('.admin-dashboard-page');
  const tabPanels = [...document.querySelectorAll('[data-admin-panel]')];
  const eventsBody = document.querySelector('#manage-events-body');
  const ordersBody = document.querySelector('#admin-orders-body');
  if (!root || !tabPanels.length || !eventsBody || !ordersBody) return;

  let events = [];
  let orders = [];
  let supportMessages = [];
  let orderFilter = 'all';
  let supportFilter = 'all';
  let selectedTierEventId = null;
  const ordersSearch = document.querySelector('#admin-orders-search');
  const supportList = document.querySelector('#support-inquiry-list');
  const supportSearch = document.querySelector('#support-search');
  const pageHeadTitle = document.querySelector('#admin-page-title');
  const pageHeadEyebrow = document.querySelector('#admin-page-eyebrow');
  const viewLabels = {
    overview: { title: 'Sales & Revenue Analytics', eyebrow: 'ADMIN OVERVIEW' },
    events: { title: 'Events & Ticket Tiers', eyebrow: 'EVENT OPERATIONS' },
    approvals: { title: 'Pending Event Approvals', eyebrow: 'MODERATION QUEUE' },
    reconciliation: { title: 'M-Pesa Reconciliation', eyebrow: 'PAYMENT OPERATIONS' },
    inquiries: { title: 'Support Inquiries', eyebrow: 'CUSTOMER CARE' }
  };
  let activeAdminView = 'overview';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const dateLabel = (value) => {
    if (!value) return 'Date to be announced';
    const normalized = String(value).replace(' ', 'T');
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? esc(value) : new Intl.DateTimeFormat('en-KE', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(parsed);
  };
  const money = (value) => Number(value || 0).toLocaleString('en-KE', { maximumFractionDigits: 2 });
  const getJson = async (url, options = {}) => {
    const response = await window.adminFetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || data.message || `Request failed (${response.status})`);
    return data;
  };
  const setFeedback = (selector, message, kind = '') => {
    const element = document.querySelector(selector);
    if (!element) return;
    element.textContent = message;
    element.className = `${element.id.includes('feedback') ? 'admin-tab-feedback' : 'admin-modal-feedback'}${kind ? ` is-${kind}` : ''}`;
  };

  function loadActiveAdminView() {
    if (!window.adminAccessReady) return;
    if (activeAdminView === 'events') loadEvents();
    if (activeAdminView === 'approvals') window.loadPendingEvents?.();
    if (activeAdminView === 'reconciliation') loadOrders();
    if (activeAdminView === 'inquiries') loadSupportMessages();
  }
  function activateAdminView(name, updateUrl = true) {
    activeAdminView = Object.hasOwn(viewLabels, name) ? name : 'overview';
    tabPanels.forEach((panel) => { panel.hidden = panel.dataset.adminPanel !== activeAdminView; });
    document.querySelectorAll('[data-admin-view-link]').forEach((link) => {
      const active = link.dataset.adminViewLink === activeAdminView;
      link.classList.toggle('is-active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    if (pageHeadTitle) pageHeadTitle.textContent = viewLabels[activeAdminView].title;
    if (pageHeadEyebrow) pageHeadEyebrow.textContent = viewLabels[activeAdminView].eyebrow;
    if (updateUrl) history.replaceState(null, '', `${window.location.pathname}?view=${activeAdminView}`);
    document.querySelector('[data-admin-sidebar-close]')?.click();
    loadActiveAdminView();
    window.dispatchEvent(new CustomEvent('twende:admin-view-changed', { detail: { view: activeAdminView } }));
  }
  document.querySelectorAll('[data-admin-view-link]').forEach((link) => link.addEventListener('click', (event) => {
    event.preventDefault();
    activateAdminView(link.dataset.adminViewLink);
  }));

  const renderEvents = () => {
    if (!events.length) {
      eventsBody.innerHTML = '<tr><td class="admin-table-message" colspan="5">No events are available to manage.</td></tr>';
      return;
    }
    eventsBody.innerHTML = events.map((item) => {
      const id = item.event_id ?? item.id;
      const poster = item.poster_url ? apiAssetUrl(item.poster_url) : '';
      const status = String(item.status || item.approval_status || 'draft').toLowerCase();
      return `<tr><td><div class="managed-event-cell">${poster ? `<img src="${esc(poster)}" alt="" loading="lazy">` : '<span class="managed-event-placeholder">TE</span>'}<strong>${esc(item.title || 'Untitled event')}</strong></div></td><td>${dateLabel(item.start_time)}</td><td>${esc(item.venue || 'Venue TBA')}${item.location ? `<small>${esc(item.location)}</small>` : ''}</td><td><span class="admin-status-badge admin-status-${esc(status)}">${esc(item.approval_status || status)}</span></td><td><div class="admin-row-actions"><button class="admin-row-button" type="button" data-admin-edit-event="${esc(id)}">Edit Event</button><button class="admin-row-button is-secondary" type="button" data-admin-manage-tiers="${esc(id)}">Manage Tiers</button></div></td></tr>`;
    }).join('');
  };

  async function loadEvents() {
    const feedback = document.querySelector('#manage-events-feedback');
    feedback.textContent = 'Loading events…';
    try {
      const result = await getJson(`${API_BASE_URL}/api/admin/events`);
      events = Array.isArray(result) ? result : [];
      renderEvents();
      feedback.textContent = `${events.length} events available for management.`;
    } catch (error) {
      console.error('Unable to load events for admin management:', error);
      eventsBody.innerHTML = '<tr><td class="admin-table-message is-error" colspan="5">Events could not be loaded.</td></tr>';
      feedback.textContent = error.message;
    }
  }
  document.querySelector('#manage-events-refresh')?.addEventListener('click', loadEvents);

  const editModal = document.querySelector('#edit-admin-event-modal');
  const editForm = document.querySelector('#edit-admin-event-form');
  const tiersModal = document.querySelector('#manage-admin-tiers-modal');
  const tiersList = document.querySelector('#admin-tiers-list');
  const closeModals = () => {
    document.querySelectorAll('.admin-modal-overlay').forEach((modal) => { modal.hidden = true; });
    document.body.classList.remove('admin-modal-open');
  };
  document.querySelectorAll('[data-close-admin-modal]').forEach((button) => button.addEventListener('click', closeModals));
  document.querySelectorAll('.admin-modal-overlay').forEach((modal) => modal.addEventListener('click', (event) => { if (event.target === modal) closeModals(); }));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeModals(); });

  eventsBody.addEventListener('click', async (event) => {
    const editButton = event.target.closest('[data-admin-edit-event]');
    if (editButton) {
      const selected = events.find((item) => String(item.event_id ?? item.id) === editButton.dataset.adminEditEvent);
      if (!selected) return;
      editForm.elements.event_id.value = selected.event_id ?? selected.id;
      editForm.elements.title.value = selected.title || '';
      editForm.elements.start_time.value = String(selected.start_time || '').replace(' ', 'T').slice(0, 16);
      editForm.elements.venue.value = selected.venue || '';
      editForm.elements.location.value = selected.location || selected.city || '';
      editForm.elements.category.value = selected.category || '';
      editForm.elements.poster_url.value = selected.poster_url || '';
      editForm.elements.description.value = selected.description || '';
      editForm.elements.status.value = String(selected.status || 'draft').toLowerCase() === 'published' ? 'published' : 'draft';
      editModal.hidden = false;
      document.body.classList.add('admin-modal-open');
      return;
    }
    const tiersButton = event.target.closest('[data-admin-manage-tiers]');
    if (tiersButton) {
      const item = events.find((row) => String(row.event_id ?? row.id) === tiersButton.dataset.adminManageTiers);
      if (!item) return;
      selectedTierEventId = Number(item.event_id ?? item.id);
      document.querySelector('#manage-admin-tiers-event').textContent = item.title || 'Event';
      tiersModal.hidden = false;
      document.body.classList.add('admin-modal-open');
      await loadTiers();
    }
  });

  editForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!editForm.reportValidity()) return;
    const button = editForm.querySelector('[type="submit"]');
    button.disabled = true;
    setFeedback('#edit-admin-event-feedback', 'Saving event…');
    const body = {
      title: editForm.elements.title.value.trim(),
      start_time: editForm.elements.start_time.value,
      venue: editForm.elements.venue.value.trim(),
      location: editForm.elements.location.value.trim(),
      category: editForm.elements.category.value.trim(),
      poster_url: editForm.elements.poster_url.value.trim(),
      description: editForm.elements.description.value.trim(),
      status: editForm.elements.status.value
    };
    try {
      await getJson(`${API_BASE_URL}/api/admin/events/${encodeURIComponent(editForm.elements.event_id.value)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      closeModals(); await loadEvents();
    } catch (error) { setFeedback('#edit-admin-event-feedback', error.message, 'error'); }
    finally { button.disabled = false; }
  });

  async function loadTiers() {
    if (!selectedTierEventId) return;
    tiersList.innerHTML = '<p class="admin-table-message">Loading ticket tiers…</p>';
    try {
      const rows = await getJson(`${API_BASE_URL}/api/admin/events/${selectedTierEventId}/tiers`);
      if (!Array.isArray(rows) || !rows.length) {
        tiersList.innerHTML = '<p class="admin-table-message">No tiers yet. Add the first tier below.</p>';
        return;
      }
      tiersList.innerHTML = rows.map((tier) => `<form class="admin-tier-edit-form" data-admin-tier-form="${esc(tier.tier_id)}"><strong>${esc(tier.tier_name || 'Ticket tier')}</strong><div class="admin-form-two-col"><label>Tier Name<input name="tier_name" value="${esc(tier.tier_name || '')}" required></label><label>Price (KES)<input name="price" type="number" min="0" step="0.01" value="${esc(tier.price)}" required></label></div><div class="admin-form-two-col"><label>Remaining Stock<input name="remaining_quantity" type="number" min="0" step="1" value="${esc(tier.remaining_quantity ?? 0)}" required></label><label>Description<input name="description" value="${esc(tier.description || '')}"></label></div><button class="admin-row-button" type="submit">Save Tier</button></form>`).join('');
    } catch (error) {
      console.error('Unable to load event ticket tiers:', error);
      tiersList.innerHTML = `<p class="admin-table-message is-error">${esc(error.message)}</p>`;
    }
  }

  tiersList.addEventListener('submit', async (event) => {
    const form = event.target.closest('[data-admin-tier-form]');
    if (!form) return;
    event.preventDefault();
    if (!form.reportValidity()) return;
    const button = form.querySelector('[type="submit"]'); button.disabled = true;
    const body = Object.fromEntries(new FormData(form).entries());
    body.price = Number(body.price); body.remaining_quantity = Number(body.remaining_quantity);
    try { await getJson(`${API_BASE_URL}/api/admin/tiers/${encodeURIComponent(form.dataset.adminTierForm)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); await loadTiers(); }
    catch (error) { window.alert(error.message); button.disabled = false; }
  });

  document.querySelector('#add-admin-tier-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!selectedTierEventId || !form.reportValidity()) return;
    const button = form.querySelector('[type="submit"]'); button.disabled = true;
    const body = Object.fromEntries(new FormData(form).entries()); body.price = Number(body.price); body.remaining_quantity = Number(body.remaining_quantity);
    try { await getJson(`${API_BASE_URL}/api/admin/events/${selectedTierEventId}/tiers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); form.reset(); await loadTiers(); }
    catch (error) { setFeedback('#tiers-feedback', error.message, 'error'); }
    finally { button.disabled = false; }
  });

  const renderOrders = () => {
    const query = String(ordersSearch?.value || '').trim().toLowerCase();
    const visible = orders.filter((order) => {
      const status = String(order.payment_status || '').toLowerCase();
      const matchesStatus = orderFilter === 'all' || (orderFilter === 'paid' ? ['paid', 'completed'].includes(status) : status === orderFilter);
      const searchText = [order.order_id, order.attendee_name, order.phone_number, order.event_title, order.tier_name, order.external_reference, order.payhero_reference, order.mpesa_receipt_number].join(' ').toLowerCase();
      return matchesStatus && (!query || searchText.includes(query));
    });
    if (!visible.length) {
      ordersBody.innerHTML = '<tr><td class="admin-table-message" colspan="8">No orders match this filter.</td></tr>';
      return;
    }
    ordersBody.innerHTML = visible.map((order) => {
      const state = String(order.payment_status || 'pending').toLowerCase();
      const paid = ['paid', 'completed'].includes(state);
      const statusClass = paid ? 'is-paid' : state === 'pending' ? 'is-pending' : 'is-failed';
      const actions = paid ? `<span class="admin-order-complete">Tickets issued</span><button class="admin-row-button is-secondary" type="button" data-admin-resend-email="${esc(order.order_id)}">Resend Email</button>` : `<button class="admin-row-button" type="button" data-check-payhero="${esc(order.order_id)}">Check PayHero</button><button class="admin-row-button is-warning" type="button" data-manual-issue="${esc(order.order_id)}">Manual Issue</button>`;
      return `<tr><td>#${esc(order.order_id)}</td><td><strong>${esc(order.attendee_name || 'Guest')}</strong><small>${esc(order.phone_number || 'N/A')}</small></td><td><strong>${esc(order.event_title || 'Event unavailable')}</strong><small>${esc(order.tier_name || 'General')}</small></td><td>KES ${money(order.total_amount)}</td><td><code>${esc(order.mpesa_receipt_number || '—')}</code>${order.failure_reason ? `<small>${esc(order.failure_reason)}</small>` : ''}</td><td><span class="admin-order-status ${statusClass}">${esc(state)}</span></td><td>${dateLabel(order.created_at)}</td><td><div class="admin-row-actions">${actions}</div></td></tr>`;
    }).join('');
  };
  async function loadOrders() {
    document.querySelector('#reconciliation-feedback').textContent = 'Loading recent orders…';
    try {
      const data = await getJson(`${API_BASE_URL}/api/admin/orders`);
      orders = Array.isArray(data) ? data : [];
      renderOrders();
      document.querySelector('#reconciliation-feedback').textContent = `${orders.length} most recent orders loaded.`;
    } catch (error) {
      console.error('Unable to load admin orders:', error);
      ordersBody.innerHTML = `<tr><td class="admin-table-message is-error" colspan="8">${esc(error.message)}</td></tr>`;
      document.querySelector('#reconciliation-feedback').textContent = 'Orders could not be loaded.';
    }
  }
  document.querySelectorAll('[data-order-status]').forEach((button) => button.addEventListener('click', () => {
    orderFilter = button.dataset.orderStatus;
    document.querySelectorAll('[data-order-status]').forEach((pill) => { const active = pill === button; pill.classList.toggle('is-active', active); pill.setAttribute('aria-pressed', String(active)); });
    renderOrders();
  }));
  ordersSearch?.addEventListener('input', renderOrders);
  document.querySelector('#reconcile-all-orders').addEventListener('click', async (event) => {
    const button = event.currentTarget; button.disabled = true;
    const feedback = document.querySelector('#reconciliation-feedback'); feedback.textContent = 'Checking pending orders with PayHero…';
    try {
      const result = await getJson(`${API_BASE_URL}/api/admin/orders/reconcile-all`, { method: 'POST' });
      feedback.textContent = `Checked ${Number(result.checked || 0)} pending orders — ${Number(result.reconciled || 0)} reconciled and tickets issued!`;
      await loadOrders();
    } catch (error) { feedback.textContent = error.message; }
    finally { button.disabled = false; }
  });
  ordersBody.addEventListener('click', async (event) => {
    const resendButton = event.target.closest('[data-admin-resend-email]');
    if (resendButton) {
      const feedback = document.querySelector('#reconciliation-feedback');
      resendButton.disabled = true;
      feedback.textContent = 'Sending tickets and receipt email…';
      try {
        const result = await getJson(`${API_BASE_URL}/api/orders/${encodeURIComponent(resendButton.dataset.adminResendEmail)}/resend-email`, { method: 'POST' });
        feedback.textContent = result.message || 'Tickets and receipt email sent.';
        await loadOrders();
        feedback.textContent = result.message || 'Tickets and receipt email sent.';
      } catch (error) {
        feedback.textContent = error.message || 'Ticket email could not be sent.';
        resendButton.disabled = false;
      }
      return;
    }
    const checkButton = event.target.closest('[data-check-payhero]');
    const manualButton = event.target.closest('[data-manual-issue]');
    const orderId = checkButton?.dataset.checkPayhero || manualButton?.dataset.manualIssue;
    if (!orderId) return;
    if (manualButton) {
      const receipt = window.prompt('Enter the M-Pesa SMS receipt code:');
      if (!receipt || !receipt.trim()) return;
      manualButton.disabled = true;
      try {
        const result = await getJson(`${API_BASE_URL}/api/admin/orders/${encodeURIComponent(orderId)}/manual-fulfill`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mpesaReceipt: receipt.trim() }) });
        window.alert(`Tickets issued successfully. Receipt: ${result.mpesaReceipt || receipt.trim().toUpperCase()}`);
        await loadOrders();
      } catch (error) { window.alert(error.message); manualButton.disabled = false; }
      return;
    }
    checkButton.disabled = true;
    try {
      const result = await getJson(`${API_BASE_URL}/api/admin/orders/${encodeURIComponent(orderId)}/reconcile`, { method: 'POST' });
      window.alert(result.status === 'paid' ? `Payment confirmed. Receipt: ${result.mpesaReceipt || 'N/A'}` : `PayHero status: ${result.payheroStatus || result.status}`);
      await loadOrders();
      document.querySelector('#analytics-refresh')?.click();
    } catch (error) { window.alert(error.message); checkButton.disabled = false; }
  });

  const renderSupportMessages = () => {
    if (!supportList) return;
    const query = String(supportSearch?.value || '').trim().toLowerCase();
    const visible = supportMessages.filter((message) => {
      const status = String(message.status || 'unread').toLowerCase();
      const text = [message.full_name, message.email, message.topic, message.order_reference, message.message].join(' ').toLowerCase();
      return (supportFilter === 'all' || status === supportFilter) && (!query || text.includes(query));
    });
    if (!visible.length) {
      supportList.innerHTML = `<div class="support-empty-state">${supportMessages.length ? 'No inquiries match your filters.' : 'No support inquiries yet.'}</div>`;
      return;
    }
    supportList.innerHTML = visible.map((item) => {
      const isUnread = String(item.status || 'unread').toLowerCase() === 'unread';
      const subject = encodeURIComponent(`Re: Twende Events Support - ${item.topic || 'Inquiry'}`);
      const checkOrder = item.order_reference
        ? `<button class="admin-row-button is-secondary" type="button" data-check-order-reference="${esc(item.order_reference)}">Check Order</button>` : '';
      return `<article class="support-inquiry-card ${isUnread ? 'is-unread' : ''}">
        <header class="support-inquiry-header"><div><h3>${esc(item.full_name)}</h3><a href="mailto:${esc(item.email)}">${esc(item.email)}</a></div><span class="support-status-badge ${isUnread ? 'is-unread' : 'is-resolved'}">${isUnread ? 'Unread' : 'Resolved'}</span></header>
        <div class="support-inquiry-meta">${item.topic ? `<span class="support-topic-badge">${esc(item.topic)}</span>` : ''}${item.order_reference ? `<span class="support-reference-badge">Order: ${esc(item.order_reference)}</span>` : ''}<time datetime="${esc(item.created_at || '')}">${dateLabel(item.created_at)}</time></div>
        <p class="support-message-body">${esc(item.message)}</p>
        <footer class="support-inquiry-actions"><a class="admin-row-button support-reply-button" href="mailto:${esc(item.email)}?subject=${subject}">Reply via Email</a>${checkOrder}<button class="admin-row-button is-secondary" type="button" data-toggle-inquiry-status="${esc(item.message_id)}" data-next-status="${isUnread ? 'resolved' : 'unread'}">${isUnread ? 'Mark Resolved' : 'Reopen'}</button><button class="admin-row-button is-warning" type="button" data-delete-inquiry="${esc(item.message_id)}">Delete</button></footer>
      </article>`;
    }).join('');
  };

  async function loadSupportMessages() {
    const feedback = document.querySelector('#support-inbox-feedback');
    if (!feedback || !supportList) return;
    feedback.textContent = 'Loading support inquiries…';
    try {
      const data = await getJson(`${API_BASE_URL}/api/admin/messages`);
      supportMessages = Array.isArray(data.messages) ? data.messages : [];
      document.querySelector('#support-unread-count').textContent = String(Number(data.unreadCount || 0));
      document.querySelector('#support-unread-count').hidden = Number(data.unreadCount || 0) === 0;
      renderSupportMessages();
      feedback.textContent = `${supportMessages.length} inquiries · ${Number(data.unreadCount || 0)} unread`;
    } catch (error) {
      console.error('Unable to load support inquiries:', error);
      feedback.textContent = error.message || 'Support inquiries could not be loaded.';
      supportList.innerHTML = '<div class="support-empty-state is-error">Support inquiries could not be loaded. Please refresh.</div>';
    }
  }
  document.querySelector('#support-refresh')?.addEventListener('click', loadSupportMessages);
  supportSearch?.addEventListener('input', renderSupportMessages);
  document.querySelectorAll('[data-support-filter]').forEach((button) => button.addEventListener('click', () => {
    supportFilter = button.dataset.supportFilter;
    document.querySelectorAll('[data-support-filter]').forEach((pill) => { const active = pill === button; pill.classList.toggle('is-active', active); pill.setAttribute('aria-pressed', String(active)); });
    renderSupportMessages();
  }));
  supportList?.addEventListener('click', async (event) => {
    const checkOrderButton = event.target.closest('[data-check-order-reference]');
    if (checkOrderButton) {
      const reference = checkOrderButton.dataset.checkOrderReference;
      if (ordersSearch) ordersSearch.value = reference;
      orderFilter = 'all';
      document.querySelectorAll('[data-order-status]').forEach((pill) => { const active = pill.dataset.orderStatus === 'all'; pill.classList.toggle('is-active', active); pill.setAttribute('aria-pressed', String(active)); });
      activateAdminView('reconciliation');
      return;
    }

    const statusButton = event.target.closest('[data-toggle-inquiry-status]');
    const deleteButton = event.target.closest('[data-delete-inquiry]');
    if (deleteButton) {
      if (!window.confirm('Delete this support inquiry? This cannot be undone.')) return;
      deleteButton.disabled = true;
      try {
        await getJson(`${API_BASE_URL}/api/admin/messages/${encodeURIComponent(deleteButton.dataset.deleteInquiry)}`, { method: 'DELETE' });
        await loadSupportMessages();
      } catch (error) { window.alert(error.message); deleteButton.disabled = false; }
      return;
    }
    if (statusButton) {
      statusButton.disabled = true;
      try {
        await getJson(`${API_BASE_URL}/api/admin/messages/${encodeURIComponent(statusButton.dataset.toggleInquiryStatus)}/status`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: statusButton.dataset.nextStatus })
        });
        await loadSupportMessages();
      } catch (error) { window.alert(error.message); statusButton.disabled = false; }
    }
  });

  window.refreshAdminView = activateAdminView;
  const requestedView = new URLSearchParams(window.location.search).get('view') || 'overview';
  activateAdminView(requestedView);
  if (!window.adminAccessReady) window.addEventListener('twende:admin-unlocked', loadActiveAdminView, { once: true });
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

async function resetUserPassword(button) {
  const userId = button?.dataset.resetPasswordId;
  const userName = button?.dataset.userName || 'this user';
  const userEmail = button?.dataset.userEmail || 'No email on file';
  if (!userId || !window.confirm(`Reset the password for ${userName} (${userEmail})? A temporary password will be generated and emailed when SMTP is available.`)) return;

  const feedback = document.querySelector('#reset-password-feedback');
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = 'Resetting…';
  if (feedback) feedback.hidden = true;

  try {
    const response = await window.adminFetch(`${API_BASE_URL}/api/admin/users/${encodeURIComponent(userId)}/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) throw new Error(data.message || data.error || `Password reset failed (${response.status}).`);

    const delivery = data.emailSent
      ? `Reset email sent to ${data.email || userEmail}.`
      : `Reset email was not delivered to ${data.email || userEmail}; share the temporary password directly.`;
    const message = `${data.message || 'Password reset successfully.'} ${delivery} Temporary password: ${data.tempPassword}`;
    if (feedback) {
      feedback.textContent = message;
      feedback.classList.toggle('is-warning', !data.emailSent);
      feedback.hidden = false;
    }
    window.alert(message);
  } catch (error) {
    console.error('Unable to reset user password:', error);
    const message = error.message || 'Could not reset this password. Please try again.';
    if (feedback) {
      feedback.textContent = message;
      feedback.classList.add('is-warning');
      feedback.hidden = false;
    } else {
      window.alert(message);
    }
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
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
        usersTableBody.innerHTML = '<tr><td class="admin-table-message" colspan="7">No registered users found.</td></tr>';
        return;
      }

      usersTableBody.innerHTML = users.map((user) => `<tr>
        <td><span class="admin-event-id">#${escapeUserValue(user.user_id ?? user.id ?? '—')}</span></td>
        <td><strong>${escapeUserValue(user.full_name || 'Name unavailable')}</strong></td>
        <td>${escapeUserValue(user.email || '—')}</td>
        <td>${escapeUserValue(user.phone_number || '—')}</td>
        <td>${user.created_at && !Number.isNaN(new Date(user.created_at).getTime()) ? escapeUserValue(new Date(user.created_at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) + ' · ' + new Date(user.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })) : 'Before tracking'}</td>
        <td><span class="admin-status-badge admin-role-badge">${escapeUserValue(user.role || 'user')}</span></td>
        <td><div class="admin-user-actions">
          <button class="admin-reset-password" type="button" data-reset-password-id="${escapeUserValue(user.user_id ?? user.id ?? '')}" data-user-name="${escapeUserValue(user.full_name || 'Name unavailable')}" data-user-email="${escapeUserValue(user.email || '')}">Reset Password</button>
          <button class="admin-delete-event" type="button" data-user-id="${escapeUserValue(user.user_id ?? user.id ?? '')}" onclick="deleteUser(this.dataset.userId)">Delete</button>
        </div></td>
      </tr>`).join('');
    } catch (error) {
      console.error('Unable to load registered users:', error);
      usersTableBody.innerHTML = '<tr><td class="admin-table-message is-error" colspan="7">Registered users could not be loaded. Please refresh to try again.</td></tr>';
    }
  };

  usersTableBody.addEventListener('click', (event) => {
    const button = event.target.closest('[data-reset-password-id]');
    if (button) resetUserPassword(button);
  });

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
  const forgotView = document.querySelector('#forgot-password-view');
  const openForgotButton = document.querySelector('#show-forgot-password');
  const backToSigninButton = document.querySelector('#back-to-signin');
  const forgotRequestForm = document.querySelector('#forgot-request-form');
  const forgotResetForm = document.querySelector('#forgot-reset-form');
  const forgotRequestStatus = document.querySelector('#forgot-request-status');
  const forgotResetStatus = document.querySelector('#forgot-reset-status');
  const forgotEmailInput = document.querySelector('#forgot-email');
  const resetCodeInput = document.querySelector('#reset-code');
  const resetPasswordInput = document.querySelector('#reset-new-password');
  const confirmResetPasswordInput = document.querySelector('#reset-confirm-password');

  const setForgotStatus = (element, message = '', type = '') => {
    if (!element) return;
    element.textContent = message;
    element.classList.toggle('is-error', type === 'error');
    element.classList.toggle('is-success', type === 'success');
  };

  openForgotButton?.addEventListener('click', () => {
    if (!forgotView) return;
    const currentIdentifier = identifierInput?.value.trim() || '';
    if (currentIdentifier.includes('@') && forgotEmailInput) forgotEmailInput.value = currentIdentifier;
    loginForm.hidden = true;
    forgotView.hidden = false;
    requestAnimationFrame(() => forgotView.classList.add('is-visible'));
    forgotEmailInput?.focus();
  });

  backToSigninButton?.addEventListener('click', () => {
    if (!forgotView) return;
    forgotView.classList.remove('is-visible');
    window.setTimeout(() => { forgotView.hidden = true; }, 240);
    loginForm.hidden = false;
    if (forgotRequestForm) forgotRequestForm.hidden = false;
    if (forgotResetForm) forgotResetForm.hidden = true;
    setForgotStatus(forgotRequestStatus);
    setForgotStatus(forgotResetStatus);
    identifierInput?.focus();
  });

  document.querySelectorAll('[data-password-toggle]').forEach((toggle) => {
    toggle.addEventListener('click', () => {
      const input = document.getElementById(toggle.dataset.passwordToggle);
      if (!input) return;
      const reveal = input.type === 'password';
      input.type = reveal ? 'text' : 'password';
      toggle.textContent = reveal ? 'Hide' : 'Show';
      toggle.setAttribute('aria-label', `${reveal ? 'Hide' : 'Show'} new password`);
      input.focus();
    });
  });

  forgotRequestForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = forgotEmailInput?.value.trim().toLowerCase() || '';
    const sendButton = forgotRequestForm.querySelector('[type="submit"]');
    setForgotStatus(forgotRequestStatus, 'Requesting your reset code…');
    if (sendButton) { sendButton.disabled = true; sendButton.setAttribute('aria-busy', 'true'); }
    try {
      const response = await fetch(`${API_BASE_URL}/api/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success === false) throw new Error(data.message || data.error || 'We could not request a reset code. Please try again.');

      forgotResetForm.querySelector('[name="email"]').value = email;
      forgotRequestForm.hidden = true;
      forgotResetForm.hidden = false;
      setForgotStatus(forgotRequestStatus, data.message || 'If an account exists for that email, a 6-digit reset code has been sent.', 'success');
      resetCodeInput?.focus();
    } catch (error) {
      setForgotStatus(forgotRequestStatus, error.message || 'We could not request a reset code. Please try again.', 'error');
    } finally {
      if (sendButton) { sendButton.disabled = false; sendButton.removeAttribute('aria-busy'); }
    }
  });

  forgotResetForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = forgotResetForm.querySelector('[name="email"]')?.value || '';
    const code = resetCodeInput?.value.trim() || '';
    const newPassword = resetPasswordInput?.value || '';
    const confirmPassword = confirmResetPasswordInput?.value || '';
    const resetButton = forgotResetForm.querySelector('[type="submit"]');
    setForgotStatus(forgotResetStatus);

    if (!/^\d{6}$/.test(code)) {
      setForgotStatus(forgotResetStatus, 'Enter the 6-digit code from your email.', 'error');
      resetCodeInput?.focus();
      return;
    }
    if (newPassword.trim().length < 6) {
      setForgotStatus(forgotResetStatus, 'Your new password must be at least 6 characters.', 'error');
      resetPasswordInput?.focus();
      return;
    }
    if (newPassword !== confirmPassword) {
      setForgotStatus(forgotResetStatus, 'The passwords do not match. Check both fields and try again.', 'error');
      confirmResetPasswordInput?.focus();
      return;
    }

    if (resetButton) { resetButton.disabled = true; resetButton.setAttribute('aria-busy', 'true'); }
    setForgotStatus(forgotResetStatus, 'Updating your password…');
    try {
      const response = await fetch(`${API_BASE_URL}/api/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code, newPassword })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) throw new Error(data.message || data.error || 'The reset code could not be verified. Request a new code and try again.');

      loginForm.hidden = false;
      forgotView.classList.remove('is-visible');
      forgotView.hidden = true;
      forgotRequestForm.hidden = false;
      forgotResetForm.hidden = true;
      identifierInput.value = email;
      passwordInput.value = '';
      forgotResetForm.reset();
      setForgotStatus(forgotRequestStatus);
      setForgotStatus(forgotResetStatus);
      statusMessage.textContent = 'Password updated! Sign in with your new password.';
      statusMessage.classList.remove('is-error');
      statusMessage.classList.add('is-success');
      passwordInput.focus();
    } catch (error) {
      setForgotStatus(forgotResetStatus, error.message || 'The password could not be updated. Please try again.', 'error');
    } finally {
      if (resetButton) { resetButton.disabled = false; resetButton.removeAttribute('aria-busy'); }
    }
  });

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

      localStorage.setItem('user', JSON.stringify({ ...data.user, token: data.token }));
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

// Attendee Hub: wallet, gate display, payment history, saved events, and profile.
(() => {
  const root = document.querySelector('.user-dashboard-page');
  if (!root) return;

  let user;
  try { user = JSON.parse(localStorage.getItem('user') || 'null'); } catch (_) { user = null; }
  if (!user?.token || !user.user_id) {
    window.location.replace('login.html?redirect=user-dashboard.html');
    return;
  }

  let tickets = [];
  let orders = [];
  let savedEvents = [];
  let ticketFilter = 'upcoming';
  const ticketList = document.querySelector('#user-ticket-list');
  const ordersBody = document.querySelector('#user-orders-list');
  const ordersMobile = document.querySelector('#user-orders-mobile');
  const savedGrid = document.querySelector('#user-saved-events');
  const ticketEmpty = document.querySelector('#user-tickets-empty');
  const savedEmpty = document.querySelector('#saved-events-empty');
  const gateModal = document.querySelector('#gate-mode-modal');
  const profileStatus = document.querySelector('#profile-form-status');

  const escapeHub = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
  const parseHubDate = (value) => {
    if (!value) return null;
    const raw = String(value);
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(raw) ? raw.replace(' ', 'T') : raw;
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };
  const formatHubDate = (value, opts = {}) => {
    const date = parseHubDate(value);
    if (!date) return value ? escapeHub(value) : 'Date to be announced';
    return new Intl.DateTimeFormat('en-KE', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', ...opts }).format(date);
  };
  const formatHubMoney = (value) => Number(value || 0).toLocaleString('en-KE', { maximumFractionDigits: 2 });
  const getTicketDate = (ticket) => ticket.event_date || ticket.start_time || ticket.event?.start_time || null;
  const isPastTicket = (ticket) => {
    const date = parseHubDate(getTicketDate(ticket));
    return Boolean(date && date.getTime() < Date.now());
  };
  const getCountdown = (value) => {
    const date = parseHubDate(value);
    if (!date) return 'Date to be announced';
    const diff = date.getTime() - Date.now();
    if (diff <= 0) return 'Event Completed';
    if (date.toDateString() === new Date().toDateString()) return 'Happening Today';
    const days = Math.floor(diff / 86400000);
    const hours = Math.floor((diff % 86400000) / 3600000);
    return days ? `Starts in ${days}d ${hours}h` : `Starts in ${hours}h`;
  };
  const resolveHubPoster = (value) => apiAssetUrl(String(value || '').trim());
  const setToast = (message, kind = 'success') => {
    if (!profileStatus) return;
    profileStatus.textContent = message;
    profileStatus.className = `profile-form-status is-${kind}`;
    window.clearTimeout(setToast.timer);
    setToast.timer = window.setTimeout(() => { profileStatus.textContent = ''; profileStatus.className = 'profile-form-status'; }, 4500);
  };

  const makeQr = (container, ticket, size = 176) => {
    if (!container || typeof QRCode !== 'function') {
      if (container) container.textContent = 'QR unavailable';
      return;
    }
    container.replaceChildren();
    const title = ticket.event_title || ticket.title || 'Twende Event';
    const attendee = ticket.attendee_name || user.full_name || 'Guest';
    const tier = ticket.tier_name || 'General';
    const code = ticket.ticket_code || '';
    const payload = `TWENDE TICKET | Event: ${title} | Holder: ${attendee} | Tier: ${tier} | Code: ${code}`.replace(/[\r\n|]/g, ' ').slice(0, 220);
    try { new QRCode(container, { text: payload, width: size, height: size, correctLevel: QRCode.CorrectLevel.M || QRCode.CorrectLevel.L }); }
    catch (error) { console.error('Unable to render attendee QR code:', error); container.textContent = code; }
  };

  const getVisibleTickets = () => tickets.filter((ticket) => {
    const status = String(ticket.ticket_status || ticket.status || 'valid').toLowerCase();
    return ticketFilter === 'upcoming' ? status === 'valid' && !isPastTicket(ticket) : status === 'used' || isPastTicket(ticket);
  });

  const renderTickets = () => {
    const rows = getVisibleTickets();
    ticketList.replaceChildren();
    if (!rows.length) {
      ticketEmpty.hidden = false;
      document.querySelector('#user-ticket-empty-title').textContent = tickets.length ? 'Nothing in this ticket view.' : 'No tickets yet.';
      document.querySelector('#user-ticket-empty-copy').textContent = tickets.length
        ? 'Try the other filter to see your valid, used or completed-event tickets.'
        : 'Find your next great night out and your tickets will appear here.';
      return;
    }
    ticketEmpty.hidden = true;
    ticketList.innerHTML = rows.map((ticket) => {
      const code = String(ticket.ticket_code || 'TICKET');
      const cardId = `ticket-card-${code}`;
      const title = ticket.event_title || ticket.title || 'Event ticket';
      const attendee = ticket.attendee_name || user.full_name || user.name || 'Guest Attendee';
      const tier = ticket.tier_name || 'General';
      const venue = ticket.venue || 'Venue to be announced';
      const location = ticket.location || 'Kisii County';
      const when = getTicketDate(ticket);
      const status = String(ticket.ticket_status || ticket.status || 'valid').toLowerCase();
      const poster = resolveHubPoster(ticket.poster_url);
      const directions = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${venue} ${location}`)}`;
      const transferActions = status === 'valid'
        ? `<button class="hub-transfer-button" type="button" data-transfer-ticket="${escapeHub(ticket.ticket_id)}">Transfer Ticket</button><button class="hub-whatsapp-button" type="button" data-share-ticket="${escapeHub(code)}">Share on WhatsApp</button>`
        : '';
      return `<article class="user-digital-ticket hub-digital-ticket" id="${escapeHub(cardId)}" data-ticket-card="${escapeHub(code)}">
        <div class="user-digital-ticket-main">
          <div class="user-ticket-poster-wrap">${poster ? `<img class="user-ticket-poster" crossorigin="anonymous" src="${escapeHub(poster)}" alt="${escapeHub(title)} poster" loading="lazy">` : ''}<span class="user-ticket-poster-fallback" ${poster ? 'hidden' : ''}>TWENDE<br>EVENT</span></div>
          <div class="user-ticket-info"><span class="user-ticket-label">TWENDE EVENT TICKET</span><h3>${escapeHub(title)}</h3>
            <span class="event-countdown-pill ${status === 'used' || isPastTicket(ticket) ? 'is-complete' : ''}">${escapeHub(getCountdown(when))}</span>
            <p class="user-ticket-venue">⌖ ${escapeHub(venue)} · ${escapeHub(location)}</p><p class="user-ticket-date">${escapeHub(formatHubDate(when, { hour: 'numeric', minute: '2-digit' }))}</p>
            <dl class="user-ticket-summary"><div><dt>ATTENDEE</dt><dd>${escapeHub(attendee)}</dd></div><div><dt>TICKET TIER</dt><dd>${escapeHub(tier)}</dd></div><div><dt>STATUS</dt><dd>${escapeHub(status)}</dd></div></dl>
            <span class="user-ticket-code">${escapeHub(code)}</span>
          </div>
        </div>
        <div class="user-ticket-qr-panel"><div id="qr-${escapeHub(code)}" class="user-ticket-qr"></div><small>SCAN AT THE GATE</small></div>
        <div class="hub-ticket-actions" data-html2canvas-ignore="true"><button class="hub-gate-button" type="button" data-gate-ticket="${escapeHub(code)}">Show at Gate</button><a class="hub-directions-button" href="${escapeHub(directions)}" target="_blank" rel="noopener noreferrer">Get Directions</a><button class="user-ticket-download" type="button" data-download-ticket="${escapeHub(code)}">Download Ticket</button>${transferActions}</div>
      </article>`;
    }).join('');
    rows.forEach((ticket) => makeQr(document.querySelector(`#qr-${CSS.escape(String(ticket.ticket_code || 'TICKET'))}`), ticket));
  };

  const receiptCanvasDownload = (order) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1100; canvas.height = 680;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f7f5f2'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.roundRect(45, 45, 1010, 590, 28); ctx.fill();
    ctx.fillStyle = '#e60000'; ctx.fillRect(45, 45, 12, 590);
    ctx.fillStyle = '#e60000'; ctx.font = '800 25px Arial'; ctx.fillText('TWENDE EVENTS · PAYMENT RECEIPT', 92, 112);
    ctx.fillStyle = '#171717'; ctx.font = '700 42px Arial'; ctx.fillText(String(order.event_title || 'Event payment').slice(0, 42), 92, 190);
    const fields = [
      ['ORDER', `#${order.order_id}`], ['TICKET TIER', order.tier_name || 'General'], ['QUANTITY', String(order.quantity || 1)],
      ['AMOUNT PAID', `KES ${formatHubMoney(order.total_amount)}`], ['M-PESA RECEIPT', order.mpesa_receipt_number || 'N/A'],
      ['PAYMENT DATE', formatHubDate(order.created_at)], ['STATUS', String(order.payment_status || 'paid').toUpperCase()]
    ];
    let y = 260;
    for (const [label, value] of fields) {
      ctx.fillStyle = '#888'; ctx.font = '700 17px Arial'; ctx.fillText(label, 92, y);
      ctx.fillStyle = '#202020'; ctx.font = '600 24px Arial'; ctx.fillText(String(value).slice(0, 55), 360, y);
      y += 49;
    }
    ctx.fillStyle = '#777'; ctx.font = '16px Arial'; ctx.fillText('Keep this receipt for your records. Your QR ticket is available in My Tickets.', 92, 588);
    const link = document.createElement('a');
    link.download = `Twende_Receipt_${String(order.order_id).replace(/\W/g, '')}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  };

  const renderOrders = () => {
    const statusClass = (status) => ['paid', 'completed'].includes(String(status).toLowerCase()) ? 'is-paid' : ['pending', 'processing'].includes(String(status).toLowerCase()) ? 'is-pending' : 'is-failed';
    const statusText = (status) => ['paid', 'completed'].includes(String(status).toLowerCase()) ? 'Paid' : ['pending', 'processing'].includes(String(status).toLowerCase()) ? 'Pending' : 'Failed';
    if (!orders.length) {
      ordersBody.innerHTML = '<tr><td colspan="8" class="hub-empty-cell">No M-Pesa orders yet.</td></tr>';
      ordersMobile.innerHTML = '<p class="hub-empty-card">No M-Pesa orders yet.</p>';
      return;
    }
    const tableRows = orders.map((order) => {
      const state = statusText(order.payment_status);
      const action = state === 'Paid'
        ? `<button class="hub-quiet-button" type="button" data-download-receipt="${escapeHub(order.order_id)}">Download Receipt</button> <button class="hub-quiet-button" type="button" data-resend-email="${escapeHub(order.order_id)}">Resend Email</button>`
        : state === 'Pending'
          ? `<button class="hub-quiet-button" type="button" data-verify-order="${escapeHub(order.external_reference || order.order_id)}">Verify Now</button>` : '—';
      return `<tr><td>#${escapeHub(order.order_id)}</td><td><strong>${escapeHub(order.event_title || 'Event')}</strong><small>${escapeHub(order.tier_name || 'General')}</small></td><td>${escapeHub(order.quantity || 1)}</td><td>KES ${formatHubMoney(order.total_amount)}</td><td><code class="receipt-code">${escapeHub(order.mpesa_receipt_number || 'N/A')}</code></td><td>${escapeHub(formatHubDate(order.created_at))}</td><td><span class="order-status ${statusClass(order.payment_status)}">${state}</span></td><td>${action}</td></tr>`;
    }).join('');
    ordersBody.innerHTML = tableRows;
    ordersMobile.innerHTML = orders.map((order) => {
      const state = statusText(order.payment_status);
      const action = state === 'Paid'
        ? `<button class="hub-quiet-button" type="button" data-download-receipt="${escapeHub(order.order_id)}">Download Receipt</button> <button class="hub-quiet-button" type="button" data-resend-email="${escapeHub(order.order_id)}">Resend Email</button>`
        : state === 'Pending' ? `<button class="hub-quiet-button" type="button" data-verify-order="${escapeHub(order.external_reference || order.order_id)}">Verify Now</button>` : '';
      return `<article class="payment-order-card"><div><small>ORDER #${escapeHub(order.order_id)}</small><span class="order-status ${statusClass(order.payment_status)}">${state}</span></div><h3>${escapeHub(order.event_title || 'Event')}</h3><p>${escapeHub(order.tier_name || 'General')} · ${escapeHub(order.quantity || 1)} ticket(s)</p><strong>KES ${formatHubMoney(order.total_amount)}</strong><code class="receipt-code">${escapeHub(order.mpesa_receipt_number || 'M-Pesa receipt pending')}</code><small>${escapeHub(formatHubDate(order.created_at))}</small>${action}</article>`;
    }).join('');
  };

  const renderSavedEvents = () => {
    savedGrid.innerHTML = savedEvents.map((event) => {
      const poster = resolveHubPoster(event.poster_url);
      const date = formatHubDate(event.event_date, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
      const image = poster ? `<img src="${escapeHub(poster)}" alt="${escapeHub(event.title)} poster" loading="lazy">` : '<span class="saved-poster-fallback">TWENDE EVENT</span>';
      return `<article class="saved-event-card"><a class="saved-event-image" href="event-details.html?id=${encodeURIComponent(event.event_id)}">${image}</a><div class="saved-event-content"><span class="user-dashboard-eyebrow">${escapeHub(event.category || 'EVENT')}</span><h3>${escapeHub(event.title || 'Event')}</h3><p>${escapeHub(date)}</p><p>⌖ ${escapeHub(event.venue || 'Venue TBA')}, ${escapeHub(event.location || 'Kisii County')}</p><div><a class="hub-primary-link" href="event-details.html?id=${encodeURIComponent(event.event_id)}">Buy Tickets</a><button type="button" class="hub-remove-saved" data-remove-saved="${escapeHub(event.event_id)}">Remove</button></div></div></article>`;
    }).join('');
    savedEmpty.hidden = savedEvents.length > 0;
    savedGrid.hidden = savedEvents.length === 0;
  };

  const fillProfile = (profile) => {
    user = { ...user, ...profile, user_id: profile.id || profile.user_id || user.user_id, token: user.token };
    document.querySelector('#user-greeting-name').textContent = user.full_name || 'there';
    document.querySelector('#profile-full-name').value = user.full_name || '';
    document.querySelector('#profile-email-input').value = user.email || '';
    document.querySelector('#profile-phone-input').value = user.phone_number || '';
    localStorage.setItem('user', JSON.stringify(user));
    syncNavbarAuthState();
  };

  const updateTabCounts = () => {
    document.querySelector('#tickets-tab-count').textContent = String(tickets.filter((ticket) => String(ticket.ticket_status || ticket.status).toLowerCase() === 'valid' && !isPastTicket(ticket)).length);
    document.querySelector('#orders-tab-count').textContent = String(orders.length);
    document.querySelector('#saved-tab-count').textContent = String(savedEvents.length);
  };

  async function loadDashboard() {
    const response = await fetch(`${API_BASE_URL}/api/user/dashboard`, { headers: { Authorization: `Bearer ${user.token}` } });
    if (response.status === 401) {
      localStorage.removeItem('user');
      window.location.replace('login.html?redirect=user-dashboard.html');
      return;
    }
    if (!response.ok) throw new Error(`Dashboard request failed (${response.status})`);
    const data = await response.json();
    if (data.user) fillProfile(data.user);
    tickets = Array.isArray(data.tickets) ? data.tickets : [];
    orders = Array.isArray(data.orders) ? data.orders : [];
    savedEvents = Array.isArray(data.savedEvents) ? data.savedEvents : [];
    renderTickets(); renderOrders(); renderSavedEvents(); updateTabCounts();
  }

  document.querySelectorAll('[data-hub-tab]').forEach((button) => button.addEventListener('click', () => {
    const tab = button.dataset.hubTab;
    document.querySelectorAll('[data-hub-tab]').forEach((item) => {
      const active = item === button;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('[data-hub-panel]').forEach((panel) => { panel.hidden = panel.dataset.hubPanel !== tab; });
  }));

  document.querySelectorAll('[data-ticket-filter]').forEach((button) => button.addEventListener('click', () => {
    ticketFilter = button.dataset.ticketFilter;
    document.querySelectorAll('[data-ticket-filter]').forEach((pill) => {
      const active = pill === button;
      pill.classList.toggle('is-active', active);
      pill.setAttribute('aria-pressed', String(active));
    });
    renderTickets();
  }));

  const closeGate = () => { gateModal.hidden = true; document.body.classList.remove('gate-mode-open'); };
  document.querySelector('#gate-mode-close').addEventListener('click', closeGate);
  document.querySelector('#gate-mode-close-cta').addEventListener('click', closeGate);
  gateModal.addEventListener('click', (event) => { if (event.target === gateModal) closeGate(); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !gateModal.hidden) closeGate(); });

  const transferModal = document.querySelector('#transfer-ticket-modal');
  const transferForm = document.querySelector('#transfer-ticket-form');
  const closeTransferModal = () => {
    transferModal.hidden = true;
    document.body.classList.remove('transfer-modal-open');
    transferForm.reset();
    document.querySelector('#transfer-ticket-status').textContent = '';
    document.querySelector('#transfer-ticket-status').className = 'transfer-ticket-status';
    document.querySelector('#transfer-whatsapp-link').hidden = true;
    transferForm.querySelector('.transfer-modal-actions').hidden = false;
    transferForm.querySelector('[type="submit"]').disabled = false;
  };
  document.querySelector('#transfer-ticket-close').addEventListener('click', closeTransferModal);
  document.querySelector('#transfer-ticket-cancel').addEventListener('click', closeTransferModal);
  transferModal.addEventListener('click', (event) => { if (event.target === transferModal) closeTransferModal(); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !transferModal.hidden) closeTransferModal(); });

  document.addEventListener('click', (event) => {
    const transferButton = event.target.closest('[data-transfer-ticket]');
    if (transferButton) {
      const ticket = tickets.find((item) => String(item.ticket_id) === transferButton.dataset.transferTicket);
      if (!ticket) return;
      transferForm.elements.ticket_id.value = ticket.ticket_id;
      document.querySelector('#transfer-ticket-event').textContent = ticket.event_title || 'Event ticket';
      document.querySelector('#transfer-ticket-tier').textContent = ticket.tier_name || 'General';
      transferModal.hidden = false;
      document.body.classList.add('transfer-modal-open');
      document.querySelector('#transfer-recipient-identifier').focus();
      return;
    }

    const shareButton = event.target.closest('[data-share-ticket]');
    if (shareButton) {
      const ticket = tickets.find((item) => String(item.ticket_code) === shareButton.dataset.shareTicket);
      if (!ticket) return;
      const eventDate = formatHubDate(getTicketDate(ticket), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' });
      const detailsUrl = `https://twende-events.onrender.com/event-details.html?id=${encodeURIComponent(ticket.event_id || '')}`;
      const message = [
        `I'm going to ${ticket.event_title || 'a Twende Events event'}!`,
        `Date & time: ${eventDate}`,
        `Venue: ${ticket.venue || 'Venue TBA'}${ticket.location ? `, ${ticket.location}` : ''}`,
        `Ticket tier: ${ticket.tier_name || 'General'}`,
        `Ticket code: ${ticket.ticket_code}`,
        `Event details: ${detailsUrl}`
      ].join('\n');
      window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank', 'noopener,noreferrer');
    }
  });

  transferForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!transferForm.reportValidity()) return;
    const ticketId = transferForm.elements.ticket_id.value;
    const recipientIdentifier = transferForm.elements.recipientIdentifier.value.trim();
    const submitButton = transferForm.querySelector('[type="submit"]');
    const statusElement = document.querySelector('#transfer-ticket-status');
    const whatsappLink = document.querySelector('#transfer-whatsapp-link');
    submitButton.disabled = true;
    statusElement.textContent = 'Transferring ticket…';
    statusElement.className = 'transfer-ticket-status is-info';
    whatsappLink.hidden = true;
    try {
      const response = await fetch(`${API_BASE_URL}/api/tickets/${encodeURIComponent(ticketId)}/transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
        body: JSON.stringify({ recipientIdentifier })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Ticket transfer could not be completed.');
      const ticket = tickets.find((item) => String(item.ticket_id) === String(ticketId));
      const detailsUrl = `https://twende-events.onrender.com/event-details.html?id=${encodeURIComponent(ticket?.event_id || '')}`;
      const message = `I transferred my ${ticket?.tier_name || 'General'} ticket for ${ticket?.event_title || 'this event'} to you. Sign in to Twende Events to find your new QR ticket: ${detailsUrl}`;
      statusElement.textContent = data.message || `Ticket transferred successfully to ${data.recipientName || 'your friend'}.`;
      statusElement.className = 'transfer-ticket-status is-success';
      whatsappLink.href = `https://wa.me/?text=${encodeURIComponent(message)}`;
      whatsappLink.hidden = false;
      transferForm.querySelector('.transfer-modal-actions').hidden = true;
      await loadDashboard();
      window.setTimeout(() => {
        if (!transferModal.hidden) closeTransferModal();
      }, 5000);
    } catch (error) {
      statusElement.textContent = error.message;
      statusElement.className = 'transfer-ticket-status is-error';
      submitButton.disabled = false;
    }
  });

  document.addEventListener('click', async (event) => {
    const gateButton = event.target.closest('[data-gate-ticket]');
    if (gateButton) {
      const ticket = tickets.find((item) => String(item.ticket_code) === gateButton.dataset.gateTicket);
      if (!ticket) return;
      document.querySelector('#gate-event-title').textContent = ticket.event_title || 'Twende Event';
      document.querySelector('#gate-attendee-name').textContent = ticket.attendee_name || user.full_name || 'Guest Attendee';
      document.querySelector('#gate-ticket-tier').textContent = ticket.tier_name || 'General';
      document.querySelector('#gate-event-date').textContent = formatHubDate(getTicketDate(ticket), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' });
      document.querySelector('#gate-ticket-code').textContent = ticket.ticket_code;
      makeQr(document.querySelector('#gate-mode-qr'), ticket, 280);
      gateModal.hidden = false; document.body.classList.add('gate-mode-open'); return;
    }

    const downloadButton = event.target.closest('[data-download-ticket]');
    if (downloadButton) {
      const code = downloadButton.dataset.downloadTicket;
      const card = document.querySelector(`[data-ticket-card="${CSS.escape(code)}"]`);
      const ticket = tickets.find((item) => String(item.ticket_code) === code);
      if (!card || typeof html2canvas !== 'function') return window.alert('Ticket download is not available right now.');
      try {
        const canvas = await html2canvas(card, { scale: 2, useCORS: true, backgroundColor: '#fff' });
        const link = document.createElement('a');
        link.href = canvas.toDataURL('image/jpeg', .96);
        link.download = `${String(ticket?.event_title || 'Twende_Event').trim().replace(/\s+/g, '_').replace(/[^\w-]/g, '')}_Ticket.jpg`;
        link.click();
      } catch (error) { console.error('Could not download the ticket:', error); window.alert('Could not download this ticket. Please try again.'); }
      return;
    }

    const resendEmailButton = event.target.closest('[data-resend-email]');
    if (resendEmailButton) {
      const orderId = resendEmailButton.dataset.resendEmail;
      resendEmailButton.disabled = true;
      try {
        const response = await fetch(`${API_BASE_URL}/api/orders/${encodeURIComponent(orderId)}/resend-email`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${user.token}` }
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || data.message || 'Ticket email could not be sent.');
        setToast(data.message || 'Tickets and receipt email sent.', 'success');
      } catch (error) {
        setToast(error.message || 'Ticket email could not be sent.', 'error');
      } finally {
        resendEmailButton.disabled = false;
      }
      return;
    }

    const receiptButton = event.target.closest('[data-download-receipt]');
    if (receiptButton) {
      const order = orders.find((item) => String(item.order_id) === receiptButton.dataset.downloadReceipt);
      if (order) receiptCanvasDownload(order);
      return;
    }

    const verifyButton = event.target.closest('[data-verify-order]');
    if (verifyButton) {
      verifyButton.disabled = true;
      try {
        const response = await fetch(`${API_BASE_URL}/api/payments/status/${encodeURIComponent(verifyButton.dataset.verifyOrder)}`, { headers: { Authorization: `Bearer ${user.token}` } });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Could not verify this payment.');
        await loadDashboard();
        setToast(data.status === 'paid' || data.payment_status === 'paid' ? 'Payment confirmed. Your ticket is in My Tickets.' : 'Payment is still processing. Check again shortly.', data.status === 'paid' ? 'success' : 'info');
      } catch (error) { setToast(error.message, 'error'); }
      finally { verifyButton.disabled = false; }
      return;
    }

    const removeSavedButton = event.target.closest('[data-remove-saved]');
    if (removeSavedButton) {
      removeSavedButton.disabled = true;
      try {
        const response = await fetch(`${API_BASE_URL}/api/user/saved-events/${encodeURIComponent(removeSavedButton.dataset.removeSaved)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${user.token}` } });
        if (!response.ok) throw new Error('Could not remove the saved event.');
        await loadDashboard();
      } catch (error) { window.alert(error.message); removeSavedButton.disabled = false; }
    }
  });

  document.querySelector('#user-profile-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const response = await fetch(`${API_BASE_URL}/api/user/profile`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
        body: JSON.stringify({ full_name: form.elements.full_name.value.trim(), phone_number: form.elements.phone_number.value.trim() })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Profile could not be updated.');
      fillProfile(data.user);
      setToast('Profile updated successfully.', 'success');
    } catch (error) { setToast(error.message, 'error'); }
    finally { submit.disabled = false; }
  });

  const hostEventForm = document.querySelector('#host-event-form');
  const hostEventStatus = document.querySelector('#host-event-status');
  hostEventForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!hostEventForm.reportValidity()) return;
    const submit = hostEventForm.querySelector('[type="submit"]');
    const formData = new FormData(hostEventForm);
    formData.set('organizer_id', String(user.user_id));
    submit.disabled = true;
    try {
      const response = await fetch(`${API_BASE_URL}/api/events/create`, { method: 'POST', body: formData });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Could not submit your event.');
      hostEventForm.reset(); hostEventStatus.textContent = 'Your event has been submitted and is pending admin approval!'; hostEventStatus.className = 'host-event-status is-success';
    } catch (error) { hostEventStatus.textContent = error.message; hostEventStatus.className = 'host-event-status is-error'; }
    finally { submit.disabled = false; }
  });

  document.querySelector('#user-logout').addEventListener('click', () => {
    localStorage.removeItem('user'); localStorage.removeItem('token'); window.location.href = 'login.html';
  });

  loadDashboard().catch((error) => {
    console.error('Unable to load attendee hub:', error);
    ticketList.innerHTML = '<p class="hub-empty-card is-error">Your dashboard could not be loaded. Please refresh to try again.</p>';
  });
})();

// Bookmark controls shared by Discover cards and the Event Details hero.
(() => {
  const savedButtons = () => [...document.querySelectorAll('[data-save-event]')];
  const session = getTwendeSession();
  if (!session) return;
  const savedEventIds = new Set();

  const syncSaveButtons = () => savedButtons().forEach((button) => {
    const saved = savedEventIds.has(String(button.dataset.saveEvent));
    button.dataset.saved = String(saved);
    button.classList.toggle('is-saved', saved);
    button.setAttribute('aria-pressed', String(saved));
    button.title = saved ? 'Remove saved event' : 'Save event';
    button.setAttribute('aria-label', saved ? 'Remove saved event' : 'Save event');
    const label = button.classList.contains('event-save-detail') ? (saved ? '♥ Saved' : '♡ Save Event') : (saved ? '♥' : '♡');
    if (button.textContent !== label) button.textContent = label;
  });

  fetch(`${API_BASE_URL}/api/user/saved-events`, { headers: { Authorization: `Bearer ${session.token}` } })
    .then(async (response) => {
      if (response.status === 401) throw new Error('Your session expired. Please sign in again to manage saved events.');
      if (!response.ok) throw new Error('Saved events could not be loaded.');
      return response.json();
    })
    .then((rows) => {
      if (Array.isArray(rows)) rows.forEach((row) => savedEventIds.add(String(row.event_id)));
      syncSaveButtons();
    })
    .catch((error) => console.error('Unable to load saved event state:', error));

  const observer = new MutationObserver(syncSaveButtons);
  observer.observe(document.body, { childList: true, subtree: true });
  syncSaveButtons();

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-save-event]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const eventId = String(button.dataset.saveEvent || '');
    if (!eventId) return;
    const wasSaved = savedEventIds.has(eventId);
    button.disabled = true;
    try {
      const response = await fetch(`${API_BASE_URL}/api/user/saved-events/${encodeURIComponent(eventId)}`, {
        method: wasSaved ? 'DELETE' : 'POST',
        headers: { Authorization: `Bearer ${session.token}` }
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Could not update your saved events.');
      if (wasSaved) savedEventIds.delete(eventId); else savedEventIds.add(eventId);
      syncSaveButtons();
    } catch (error) {
      console.error('Unable to update saved event:', error);
      window.alert(error.message || 'Could not update your saved events.');
    } finally {
      button.disabled = false;
    }
  });
})();
