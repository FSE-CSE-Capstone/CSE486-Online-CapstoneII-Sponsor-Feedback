// Full updated scripts.js
(function () {
  'use strict';

  // --- Configuration (Cloudflare Workers endpoints) ---
  var ENDPOINT_URL = 'https://cse486-online-worker.sbecerr7.workers.dev/';  // POST submissions here
  var DATA_LOADER_URL = 'https://cse486-online-data-loader.sbecerr7.workers.dev/';     // GET sponsor/project data here
  var STORAGE_KEY = 'sponsor_progress_v1';
  // set to 'online' for the online deployment, 'hybrid' or '' otherwise
  var DATA_SOURCE = 'online';


  // Rubric
  var RUBRIC = [
    { title: "Student has contributed an appropriate amount of development effort towards this project", description: "Development effort should be balanced between all team members; student should commit to a fair amount of development effort on each sprint." },
    { title: "Meetings", description: "Students are expected to be proactive. Contributions and participation in meetings help ensure the student is aware of project goals." },
    { title: "Understanding", description: "Students are expected to understand important details of the project and be able to explain it from different stakeholder perspectives." },
    { title: "Quality", description: "Students should complete assigned work to a high quality: correct, documented, and self-explanatory where appropriate." },
    { title: "Communication", description: "Students are expected to be in regular communication and maintain professionalism when interacting with the sponsor." }
  ];

  // DOM refs
  var $ = function (id) { return document.getElementById(id); };
  var stageIdentity = $('stage-identity');
  var stageProjects = $('stage-projects');
  var stageThankyou = $('stage-thankyou');
  var identitySubmit = $('identitySubmit');
  var backToIdentity = $('backToIdentity');
  var nameInput = $('fullName');
  var emailInput = $('email');
  var projectListEl = $('project-list');
  var matrixContainer = $('matrix-container');
  var formStatus = $('form-status');
  var submitProjectBtn = $('submitProject');
  var finishStartOverBtn = $('finishStartOver');
  var welcomeBlock = $('welcome-block');
  var underTitle = $('under-title');

  // State
  var sponsorData = {};
  var sponsorProjects = {};
  var currentEmail = '';
  var currentName = '';
  var currentProject = '';
  var completedProjects = {};
  var stagedRatings = {};

  // ------- Helpers -------
  function setStatus(msg, color) {
    if (!formStatus) return;
    formStatus.textContent = msg || '';
    formStatus.style.color = color || '';
  }
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, function (m) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m];
    });
  }

  // element builder utility to reduce repetition
  function el(tag, props, children) {
    var n = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        if (k === 'class') n.className = props[k];
        else if (k === 'html') n.innerHTML = props[k];
        else if (k === 'text') n.textContent = props[k];
        else if (k === 'style') Object.assign(n.style, props[k]);
        else n.setAttribute(k, props[k]);
      });
    }
    if (children) children.forEach(function (c) { if (typeof c === 'string') n.appendChild(document.createTextNode(c)); else n.appendChild(c); });
    return n;
  }

  // Clean tokens and build sponsor map
  function buildSponsorMap(rows) {
    var map = {};
    if (!Array.isArray(rows)) return map;
    var emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
    function cleanToken(tok) {
      if (!tok) return '';
      return tok.replace(/^[\s"'`([{]+|[\s"'`)\]}.,:;]+$/g, '').replace(/\u00A0/g, ' ').trim();
    }
    rows.forEach(function (rawRow) {
      var project = '', student = '', sponsorCell = '';
      Object.keys(rawRow || {}).forEach(function (rawKey) {
        var keyNorm = String(rawKey || '').trim().toLowerCase();
        var rawVal = (rawRow[rawKey] || '').toString().replace(/\u00A0/g, ' ').trim();
        if (!project && /^(project|project name|project_title|group_name|projectname)$/.test(keyNorm)) project = rawVal;
        else if (!student && /^(student|student name|students|name|student_name)$/.test(keyNorm)) student = rawVal;
        else if (!sponsorCell && /^(sponsoremail|sponsor email|sponsor|email|login_id|sponsor_email)$/.test(keyNorm)) sponsorCell = rawVal;
      });

      // fallback: extract emails from any cell
      if (!sponsorCell) {
        var fallback = [];
        Object.keys(rawRow || {}).forEach(function (k) {
          var rv = (rawRow[k] || '').toString();
          var found = rv.match(emailRegex);
          if (found) fallback = fallback.concat(found);
        });
        if (fallback.length) sponsorCell = fallback.join(', ');
      }

      project = (project || '').trim(); student = (student || '').trim();
      if (!sponsorCell || !project || !student) return;

      var tokens = sponsorCell.split(/[,;\/|]+/);
      var foundEmails = [];
      tokens.forEach(function (t) {
        var cleaned = cleanToken(t);
        if (!cleaned) return;
        var matches = cleaned.match(emailRegex) || t.match(emailRegex) || (t.replace(/\s+/g, '').match(emailRegex) || []);
        if (matches) matches.forEach(function (em) { foundEmails.push(em.toLowerCase().trim()); });
      });

      var unique = [];
      foundEmails.forEach(function (e) {
        if (!e || e.indexOf('@') === -1) return;
        var parts = e.split('@');
        if (parts.length !== 2 || parts[1].indexOf('.') === -1) return;
        if (unique.indexOf(e) === -1) unique.push(e);
      });
      if (!unique.length) return;
      unique.forEach(function (email) {
        if (!map[email]) map[email] = { projects: {} };
        if (!map[email].projects[project]) map[email].projects[project] = [];
        if (map[email].projects[project].indexOf(student) === -1) map[email].projects[project].push(student);
      });
    });
    return map;
  }

  // Persistence
  function saveProgress() {
    var payload = { name: currentName, email: currentEmail, completedProjects: completedProjects, stagedRatings: stagedRatings };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(payload)); } catch (e) { console.warn('Could not save progress', e); }
  }
  function loadProgress() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var obj = JSON.parse(raw);
      if (obj && obj.email) {
        currentName = obj.name || '';
        currentEmail = obj.email || '';
        completedProjects = obj.completedProjects || {};
        stagedRatings = obj.stagedRatings || {};
        if (nameInput) nameInput.value = currentName;
        if (emailInput) emailInput.value = currentEmail;
      }
    } catch (e) { console.warn('Could not load progress', e); }
  }

  // Populate project list
  function populateProjectListFor(email) {
    if (!projectListEl) return;
    projectListEl.innerHTML = '';
    sponsorProjects = {};
    var entry = sponsorData[email];
    if (!entry || !entry.projects) { setStatus('No projects found for that email.', 'red'); return; }
    var allProjects = Object.keys(entry.projects).slice();
    allProjects.sort(function (a, b) {
      var ca = completedProjects[a] ? 1 : 0;
      var cb = completedProjects[b] ? 1 : 0;
      return ca - cb;
    });
    allProjects.forEach(function (p) {
      var li = el('li', { class: 'project-item', tabindex: 0, 'data-project': p });
      li.innerHTML = completedProjects[p]
        ? '<strong>' + escapeHtml(p) + '</strong> <span class="meta">(completed)</span>'
        : '<strong>' + escapeHtml(p) + '</strong>';
      li.addEventListener('click', function () {
        if (completedProjects[p]) { setStatus('This project is already completed.', 'red'); return; }
        Array.from(projectListEl.querySelectorAll('.project-item.active')).forEach(function (a) { a.classList.remove('active'); });
        li.classList.add('active');
        currentProject = p;
        loadProjectIntoMatrix(p, entry.projects[p]);
        setStatus('');
      });
      projectListEl.appendChild(li);
      sponsorProjects[p] = entry.projects[p].slice();
    });
    setStatus('');
  }

  // Remove empty placeholder cards (kept small & defensive)
  function removeEmptyPlaceholderCards() {
    if (!projectListEl) return;
    var container = projectListEl.parentNode;
    if (!container) return;
    Array.from(container.querySelectorAll('.card')).forEach(function (c) {
      var hasControls = c.querySelector('input, textarea, select, button, table, label');
      var text = (c.textContent || '').replace(/\s+/g, '');
      if (!hasControls && text.length === 0 && !c.classList.contains('matrix-card') && !c.classList.contains('persistent-placeholder')) {
        c.parentNode && c.parentNode.removeChild(c);
      }
    });
  }

  // Build matrix for a project
  function loadProjectIntoMatrix(projectName, students) {
    if (!projectName) return;
    currentProject = projectName;

    // cleanup prior UI fragments
    var existingInfo = $('matrix-info'); if (existingInfo && existingInfo.parentNode) existingInfo.parentNode.removeChild(existingInfo);
    Array.from(document.querySelectorAll('.current-project-header')).forEach(function (h) { if (h.parentNode) h.parentNode.removeChild(h); });
    var oldComment = document.querySelector('.section.section-comment'); if (oldComment && oldComment.parentNode) oldComment.parentNode.removeChild(oldComment);

    // header/info
    var info = el('div', { id: 'matrix-info' });
    var hdr = el('div', { class: 'current-project-header', text: projectName, style: { display: 'block', marginBottom: '6px', fontWeight: '600' } });
    var topDesc = el('div', { class: 'matrix-info-desc', text: 'Please evaluate the students using the rubric below (scale 1–7).', style: { display: 'block', color: '#0b1228', fontWeight: '400', fontSize: '14px', marginBottom: '12px' } });
    info.appendChild(hdr); info.appendChild(topDesc);
    if (matrixContainer && matrixContainer.parentNode) matrixContainer.parentNode.insertBefore(info, matrixContainer);
    else if (matrixContainer) document.body.insertBefore(info, matrixContainer);

    if (!students || !students.length) {
      if (matrixContainer) matrixContainer.textContent = 'No students found for this project.';
      return;
    }

    if (!stagedRatings[currentProject]) stagedRatings[currentProject] = {};

    // build matrix content in a temp container
    var temp = document.createElement('div');

    RUBRIC.forEach(function (crit, cIdx) {
      var card = el('div', { class: 'card matrix-card', style: { marginBottom: '20px', padding: '18px' } });
      var critWrap = el('div', { class: 'matrix-criterion' });
      var critTitle = el('h4', { class: 'matrix-criterion-title', text: (cIdx + 1) + '. ' + crit.title, style: { margin: '0 0 8px 0', fontWeight: '600' } });
      var critDesc = el('div', { class: 'matrix-criterion-desc', text: crit.description, style: { display: 'block', color: '#0b1228', fontWeight: '400', fontSize: '14px', lineHeight: '1.3', margin: '0 0 12px 0' } });
      critWrap.appendChild(critTitle); critWrap.appendChild(critDesc);

      // table with colgroup & headers
      var table = el('table', { class: 'matrix-table' });
      var colgroup = el('colgroup');
      colgroup.appendChild(el('col', { style: { width: '46%' } }));
      colgroup.appendChild(el('col', { style: { width: '12%' } }));
      for (var ci = 0; ci < 7; ci++) colgroup.appendChild(el('col', { style: { width: '4%' } }));
      colgroup.appendChild(el('col', { style: { width: '12%' } }));
      table.appendChild(colgroup);

      var thead = el('thead');
      var trHead = el('tr');
      trHead.appendChild(el('th', { text: 'Student', style: { textAlign: 'left', padding: '8px' } }));
      trHead.appendChild(el('th', { class: 'header-descriptor', html: '<div class="hd-line">Far Below Expectations</div><div class="hd-sub">(Fail)</div>', style: { textAlign: 'center', padding: '8px' } }));
      for (var k = 1; k <= 7; k++) trHead.appendChild(el('th', { text: String(k), style: { padding: '8px', textAlign: 'center' } }));
      trHead.appendChild(el('th', { class: 'header-descriptor header-descriptor-right', html: '<div class="hd-line">Exceeds Expectations</div><div class="hd-sub">(A+)</div>', style: { textAlign: 'center', padding: '8px' } }));
      thead.appendChild(trHead); table.appendChild(thead);

      var tbody = el('tbody');
      students.forEach(function (studentName, sIdx) {
        var tr = el('tr');
        tr.appendChild(el('td', { text: studentName, style: { padding: '8px 10px', verticalAlign: 'middle', textAlign: 'left' } }));
        tr.appendChild(el('td', { class: 'col-descriptor', style: { padding: '8px' } }));

        for (var score = 1; score <= 7; score++) {
          var td = el('td', { style: { textAlign: 'center', padding: '8px' } });
          var input = el('input', { type: 'radio', name: 'rating-' + cIdx + '-' + sIdx, value: String(score), id: 'rating-' + cIdx + '-' + sIdx + '-' + score });
          var stagedForStudent = (stagedRatings[currentProject] && stagedRatings[currentProject][sIdx]) || {};
          if (stagedForStudent[cIdx] && String(stagedForStudent[cIdx]) === String(score)) input.checked = true;
          var label = el('label', { for: input.id, style: { cursor: 'pointer', display: 'inline-block', padding: '2px' } });
          label.appendChild(input); td.appendChild(label); tr.appendChild(td);
        }

        tr.appendChild(el('td', { class: 'col-descriptor', style: { padding: '8px' } }));
        tbody.appendChild(tr);
      });

      // team row
      var trTeam = el('tr');
      trTeam.appendChild(el('td', { text: 'Team Overall', style: { padding: '8px 10px', verticalAlign: 'middle', textAlign: 'left' } }));
      trTeam.appendChild(el('td', { class: 'col-descriptor', style: { padding: '8px' } }));
      for (var sScore = 1; sScore <= 7; sScore++) {
        var tdT = el('td', { style: { textAlign: 'center', padding: '8px' } });
        var inputT = el('input', { type: 'radio', name: 'rating-' + cIdx + '-team', value: String(sScore), id: 'rating-' + cIdx + '-team-' + sScore });
        var stagedTeam = (stagedRatings[currentProject] && stagedRatings[currentProject].team) || {};
        if (stagedTeam[cIdx] && String(stagedTeam[cIdx]) === String(sScore)) inputT.checked = true;
        var lblT = el('label', { for: inputT.id, style: { cursor: 'pointer', display: 'inline-block', padding: '2px' } });
        lblT.appendChild(inputT); tdT.appendChild(lblT); trTeam.appendChild(tdT);
      }
      trTeam.appendChild(el('td', { class: 'col-descriptor', style: { padding: '8px' } }));
      tbody.appendChild(trTeam);

      table.appendChild(tbody); critWrap.appendChild(table); card.appendChild(critWrap); temp.appendChild(card);
    });

    // replace matrix content
    if (matrixContainer) {
      matrixContainer.innerHTML = '';
      while (temp.firstChild) matrixContainer.appendChild(temp.firstChild);
    }

    renderCommentSection(projectName, students);
    attachMatrixListeners();

    // After rendering, attach radio toggle handlers to the newly created radios
    if (typeof window.__attachRadioToggle === 'function') {
      Array.prototype.forEach.call(matrixContainer.querySelectorAll("input[type='radio']"), function (r) { window.__attachRadioToggle(r); });
    }
  }

  // Render comment area (per-student & group)
  function renderCommentSection(projectName, students) {
    var oldComment = document.querySelector('.section.section-comment'); if (oldComment && oldComment.parentNode) oldComment.parentNode.removeChild(oldComment);

    var commentSec = el('div', { class: 'section section-comment', style: { marginTop: '12px', display: 'block' } });
    commentSec.appendChild(el('h3', { text: 'Add your additional comments', style: { margin: '0 0 12px 0', fontSize: '1rem', fontWeight: '700' } }));

    var staged = (stagedRatings[projectName] && stagedRatings[projectName]._studentComments) || {};

    students.forEach(function (studentName, sIdx) {
      var wrapper = el('div', { class: 'student-comment-panel', style: { border: '1px solid rgba(10,12,30,0.05)', borderRadius: '8px', padding: '10px', marginBottom: '10px', background: '#fff' } });
      var headerRow = el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' } });
      headerRow.appendChild(el('div', { text: studentName, style: { fontWeight: '600' } }));

      var toggleBtn = el('button', { type: 'button', class: 'btn btn-mini comment-toggle', text: '▾ Add comment', style: { fontSize: '0.85rem', padding: '6px 8px', cursor: 'pointer', background: 'white', border: '1px solid rgba(10,12,30,0.06)', borderRadius: '6px' } });
      headerRow.appendChild(toggleBtn); wrapper.appendChild(headerRow);

      var content = el('div', { class: 'student-comment-content', style: { display: 'none' } });
      content.appendChild(el('div', { text: 'Comments to be SHARED WITH THE STUDENT', style: { fontSize: '0.9rem', margin: '4px 0' } }));
      var taPublic = el('textarea', { id: 'comment-public-' + sIdx, placeholder: 'Comments to share with student', style: { width: '100%', minHeight: '60px', padding: '8px', boxSizing: 'border-box', marginBottom: '8px' } });
      content.appendChild(taPublic);
      content.appendChild(el('div', { text: 'Comments to be SHARED ONLY WITH THE INSTRUCTOR', style: { fontSize: '0.9rem', margin: '4px 0' } }));
      var taPrivate = el('textarea', { id: 'comment-private-' + sIdx, placeholder: 'Private comments for instructor', style: { width: '100%', minHeight: '60px', padding: '8px', boxSizing: 'border-box' } });
      content.appendChild(taPrivate);

      toggleBtn.addEventListener('click', function () {
        if (content.style.display === 'none') { content.style.display = 'block'; toggleBtn.textContent = '▴ Hide comment'; } else { content.style.display = 'none'; toggleBtn.textContent = '▾ Add comment'; }
      });

      var st = staged && staged[studentName];
      if (st) {
        if (st.public) taPublic.value = st.public;
        if (st.private) taPrivate.value = st.private;
        if ((st.public && st.public.length) || (st.private && st.private.length)) { content.style.display = 'block'; toggleBtn.textContent = '▴ Hide comment'; }
      }

      wrapper.appendChild(content);
      commentSec.appendChild(wrapper);
    });

    // Group panel
    var groupWrap = el('div', { class: 'student-comment-panel', style: { border: '1px solid rgba(10,12,30,0.05)', borderRadius: '8px', padding: '10px', marginBottom: '10px', background: '#fff' } });
    var groupHeader = el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' } });
    groupHeader.appendChild(el('div', { text: 'Comments for team overall', style: { fontWeight: '600' } }));
    var groupToggle = el('button', { type: 'button', class: 'btn btn-mini comment-toggle', text: '▾ Add comment', style: { fontSize: '0.85rem', padding: '6px 8px', cursor: 'pointer', background: 'white', border: '1px solid rgba(10,12,30,0.06)', borderRadius: '6px' } });
    groupHeader.appendChild(groupToggle); groupWrap.appendChild(groupHeader);
    var groupContent = el('div', { style: { display: 'none' } });
    groupContent.appendChild(el('div', { text: 'Comments for team overall (shared with student by default)', style: { margin: '4px 0' } }));
    var taGroup = el('textarea', { id: 'comment-group-public', placeholder: 'Comments for team overall', style: { width: '100%', minHeight: '80px', padding: '8px', boxSizing: 'border-box' } });
    groupContent.appendChild(taGroup);
    groupContent.appendChild(el('div', { text: 'Private comments about the team (instructor only)', style: { margin: '8px 0 4px 0' } }));
    var taGroupPrivate = el('textarea', { id: 'comment-group-private', placeholder: 'Private comments for instructor about the team', style: { width: '100%', minHeight: '60px', padding: '8px', boxSizing: 'border-box' } });
    groupContent.appendChild(taGroupPrivate);

    groupToggle.addEventListener('click', function () {
      if (groupContent.style.display === 'none') { groupContent.style.display = 'block'; groupToggle.textContent = '▴ Hide comment'; } else { groupContent.style.display = 'none'; groupToggle.textContent = '▾ Add comment'; }
    });

    var stagedGroup = (stagedRatings[currentProject] && stagedRatings[currentProject]._groupComments) || {};
    if (stagedGroup) {
      if (stagedGroup.public) taGroup.value = stagedGroup.public;
      if (stagedGroup.private) taGroupPrivate.value = stagedGroup.private;
      if ((stagedGroup.public && stagedGroup.public.length) || (stagedGroup.private && stagedGroup.private.length)) { groupContent.style.display = 'block'; groupToggle.textContent = '▴ Hide comment'; }
    }

    groupWrap.appendChild(groupContent);
    commentSec.appendChild(groupWrap);

    if (matrixContainer && matrixContainer.parentNode) {
      if (matrixContainer.nextSibling) matrixContainer.parentNode.insertBefore(commentSec, matrixContainer.nextSibling);
      else matrixContainer.parentNode.appendChild(commentSec);
    } else document.body.appendChild(commentSec);
  }

  // Attach listeners for saves (debounced minimal)
  function attachMatrixListeners() {
    if (!matrixContainer) return;
    // prevent double-binding by removing if possible
    try { matrixContainer.removeEventListener && matrixContainer.removeEventListener('change', saveDraftHandler); matrixContainer.removeEventListener && matrixContainer.removeEventListener('input', saveDraftHandler); } catch (e) {}
    matrixContainer.addEventListener('change', saveDraftHandler);
    matrixContainer.addEventListener('input', saveDraftHandler);

    var commentSec = document.querySelector('.section.section-comment');
    if (commentSec) {
      Array.from(commentSec.querySelectorAll('textarea')).forEach(function (ta) {
        try { ta.removeEventListener && ta.removeEventListener('input', saveDraftHandler); } catch (e) {}
        ta.addEventListener('input', saveDraftHandler);
      });
    }
  }

  // Save draft: collect selected ratings + comments
  function saveDraftHandler() {
    if (!currentProject) return;
    if (!stagedRatings[currentProject]) stagedRatings[currentProject] = {};
    var students = sponsorProjects[currentProject] || [];

    // student ratings
    for (var s = 0; s < students.length; s++) {
      stagedRatings[currentProject][s] = stagedRatings[currentProject][s] || {};
      for (var c = 0; c < RUBRIC.length; c++) {
        var sel = document.querySelector('input[name="rating-' + c + '-' + s + '"]:checked');
        if (sel) stagedRatings[currentProject][s][c] = parseInt(sel.value, 10);
        else if (stagedRatings[currentProject][s] && stagedRatings[currentProject][s][c] !== undefined) { /* keep */ }
        else stagedRatings[currentProject][s][c] = null;
      }
    }

    // team ratings
    stagedRatings[currentProject].team = stagedRatings[currentProject].team || {};
    for (var ct = 0; ct < RUBRIC.length; ct++) {
      var selT = document.querySelector('input[name="rating-' + ct + '-team"]:checked');
      if (selT) stagedRatings[currentProject].team[ct] = parseInt(selT.value, 10);
      else if (stagedRatings[currentProject].team && stagedRatings[currentProject].team[ct] !== undefined) { /* keep */ }
      else stagedRatings[currentProject].team[ct] = null;
    }

    // comments
    stagedRatings[currentProject]._studentComments = stagedRatings[currentProject]._studentComments || {};
    for (var i = 0; i < students.length; i++) {
      var sName = students[i];
      var pubEl = document.getElementById('comment-public-' + i);
      var privEl = document.getElementById('comment-private-' + i);
      stagedRatings[currentProject]._studentComments[sName] = stagedRatings[currentProject]._studentComments[sName] || { public: '', private: '' };
      if (pubEl) stagedRatings[currentProject]._studentComments[sName].public = pubEl.value || '';
      if (privEl) stagedRatings[currentProject]._studentComments[sName].private = privEl.value || '';
    }

    stagedRatings[currentProject]._groupComments = stagedRatings[currentProject]._groupComments || { public: '', private: '' };
    var gpPub = document.getElementById('comment-group-public');
    var gpPriv = document.getElementById('comment-group-private');
    if (gpPub) stagedRatings[currentProject]._groupComments.public = gpPub.value || '';
    if (gpPriv) stagedRatings[currentProject]._groupComments.private = gpPriv.value || '';

    // legacy support
    var legacyTa = document.getElementById('project-comment');
    if (legacyTa && legacyTa.value) stagedRatings[currentProject]._comment = legacyTa.value;

    saveProgress();
  }

  // Build payload and submit current project
  function submitCurrentProject() {
    if (!currentProject) { setStatus('No project is loaded.', 'red'); return; }
    var students = sponsorProjects[currentProject] || [];
    if (!students.length) { setStatus('No students to submit.', 'red'); return; }

    var responses = [];
    for (var s = 0; s < students.length; s++) {
      var ratingsObj = {};
      for (var c = 0; c < RUBRIC.length; c++) {
        var sel = document.querySelector('input[name="rating-' + c + '-' + s + '"]:checked');
        ratingsObj[RUBRIC[c].title || ('C' + c)] = sel ? parseInt(sel.value, 10) : null;
      }
      var commentShared = (document.getElementById('comment-public-' + s) || {}).value || '';
      var commentInstructor = (document.getElementById('comment-private-' + s) || {}).value || '';
      responses.push({ student: students[s], ratings: ratingsObj, commentShared: commentShared, commentInstructor: commentInstructor, isTeam: false });
    }

    // team
    var teamRatingsChosen = false;
    var teamRatingsObj = {};
    for (var tc = 0; tc < RUBRIC.length; tc++) {
      var teamSel = document.querySelector('input[name="rating-' + tc + '-team"]:checked');
      teamRatingsObj[RUBRIC[tc].title || ('C' + tc)] = teamSel ? parseInt(teamSel.value, 10) : null;
      if (teamSel) teamRatingsChosen = true;
    }
    var groupCommentShared = (document.getElementById('comment-group-public') || {}).value || '';
    var groupCommentInstructor = (document.getElementById('comment-group-private') || {}).value || '';
    if (teamRatingsChosen || groupCommentShared || groupCommentInstructor) {
      responses.push({ student: 'Evaluating group as a whole', ratings: teamRatingsObj, commentShared: groupCommentShared, commentInstructor: groupCommentInstructor, isTeam: true });
    }

    if (!responses.length) { setStatus('Nothing to submit.', 'red'); return; }

    var payload = {
      sponsorName: currentName || (nameInput ? nameInput.value.trim() : ''),
      sponsorEmail: currentEmail || (emailInput ? emailInput.value.trim() : ''),
      project: currentProject,
      rubric: RUBRIC.map(function (r) { return r.title; }),
      responses: responses,
      timestamp: new Date().toISOString()
    };

    setStatus('Submitting...', 'black');
    if (submitProjectBtn) submitProjectBtn.disabled = true;

    fetch(ENDPOINT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (resp) {
      if (!resp.ok) {
        return resp.text().then(function (txt) { throw new Error('Server error ' + resp.status + ': ' + txt); });
      }
      return resp.json().catch(function () { return {}; });
    }).then(function () {
      setStatus('Submission saved. Thank you!', 'green');

      completedProjects[currentProject] = true;
      if (stagedRatings && stagedRatings[currentProject]) delete stagedRatings[currentProject];
      saveProgress();

      if (projectListEl) {
        var selector = 'li[data-project="' + CSS.escape(currentProject) + '"]';
        var li = projectListEl.querySelector(selector);
        if (li) {
          li.classList.add('completed'); li.classList.remove('active');
          li.innerHTML = '<strong>' + escapeHtml(currentProject) + '</strong> <span class="meta">(completed)</span>';
        }
      }

      if (matrixContainer) matrixContainer.innerHTML = '';
      var commentSection = document.querySelector('.section.section-comment'); if (commentSection) commentSection.parentNode.removeChild(commentSection);
      var headerEl = document.querySelector('.current-project-header'); if (headerEl && headerEl.parentNode) headerEl.parentNode.removeChild(headerEl);
      var matrixInfoBlock = $('matrix-info'); if (matrixInfoBlock) matrixInfoBlock.style.display = 'none';
      currentProject = '';
      if (hasCompletedAllProjects()) showThankyouStage();
    }).catch(function (err) {
      console.error('Submission failed', err);
      setStatus('Submission failed. See console.', 'red');
    }).finally(function () { if (submitProjectBtn) submitProjectBtn.disabled = false; });
  }

  function hasCompletedAllProjects() {
    var entry = sponsorData[currentEmail] || {};
    var all = Object.keys(entry.projects || {});
    for (var i = 0; i < all.length; i++) if (!completedProjects[all[i]]) return false;
    return true;
  }

  // Identity submit
  function onIdentitySubmit() {
    var name = nameInput ? nameInput.value.trim() : '';
    var email = emailInput ? (emailInput.value || '').toLowerCase().trim() : '';
    if (!name) { setStatus('Please enter your name.', 'red'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setStatus('Please enter a valid email.', 'red'); return; }

    currentName = name; currentEmail = email; saveProgress();
    if (!sponsorData || Object.keys(sponsorData).length === 0) {
      setStatus('Loading project data, please wait...', 'black');
      tryFetchData(function () {
        if (!sponsorData || !sponsorData[currentEmail]) { setStatus('No projects found for that email.', 'red'); return; }
        showProjectsStage(); populateProjectListFor(currentEmail);
      });
    } else {
      if (!sponsorData[currentEmail]) { setStatus('No projects found for that email.', 'red'); return; }
      showProjectsStage(); populateProjectListFor(currentEmail);
    }
  }

  // Event wiring
  if (identitySubmit) identitySubmit.addEventListener('click', onIdentitySubmit);
  if (backToIdentity) backToIdentity.addEventListener('click', showIdentityStage);
  if (submitProjectBtn) submitProjectBtn.addEventListener('click', submitCurrentProject);
  if (finishStartOverBtn) finishStartOverBtn.addEventListener('click', function () {
    completedProjects = {}; stagedRatings = {}; saveProgress(); currentProject = '';
    if (matrixContainer) matrixContainer.innerHTML = '';
    var commentSection = document.querySelector('.section.section-comment'); if (commentSection) commentSection.parentNode.removeChild(commentSection);
    showIdentityStage();
  });

  // Stage display helpers
  function showIdentityStage() {
    if (stageIdentity) stageIdentity.style.display = '';
    if (stageProjects) stageProjects.style.display = 'none';
    if (stageThankyou) stageThankyou.style.display = 'none';
    if (welcomeBlock) welcomeBlock.style.display = '';
    if (underTitle) underTitle.style.display = '';
    setStatus('');
  }
  function showProjectsStage() {
    if (stageIdentity) stageIdentity.style.display = 'none';
    if (stageProjects) stageProjects.style.display = '';
    if (stageThankyou) stageThankyou.style.display = 'none';
    if (welcomeBlock) welcomeBlock.style.display = 'none';
    if (underTitle) underTitle.style.display = 'none';
  }
  function showThankyouStage() {
    if (stageIdentity) stageIdentity.style.display = 'none';
    if (stageProjects) stageProjects.style.display = 'none';
    if (stageThankyou) stageThankyou.style.display = '';
    if (welcomeBlock) welcomeBlock.style.display = 'none';
    if (underTitle) underTitle.style.display = 'none';
  }

  // Fetch sponsor data
  function tryFetchData(callback) {
    var loaderUrl = DATA_LOADER_URL;
    console.info('tryFetchData: requesting', loaderUrl);
    fetch(loaderUrl, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('Data loader returned ' + r.status);
        return r.json();
      })
      .then(function (rows) {
        sponsorData = buildSponsorMap(rows || []);
        setStatus('Project data loaded securely.', 'green');
        loadProgress();
        if (currentEmail && sponsorData[currentEmail]) { showProjectsStage(); populateProjectListFor(currentEmail); }
        if (typeof callback === 'function') callback();
      })
      .catch(function (err) {
        console.error('Data fetch failed', err);
        setStatus('Project data not found. Please try again later.', 'red');
        if (typeof callback === 'function') callback();
      });
  }

  // UI cleanup on DOM ready
  document.addEventListener('DOMContentLoaded', function () {
    var autoFooter = document.querySelector('.site-footer-fixed'); if (autoFooter) autoFooter.parentNode.removeChild(autoFooter);
    var identityStage = document.querySelector('[data-stage="identity"]') || $('stage-identity');
    if (identityStage) {
      Array.from(identityStage.querySelectorAll('button')).forEach(function (b) {
        if (b.textContent && b.textContent.trim() === 'Submit ratings for project') b.style.display = 'none';
      });
    }
  });

  // Boot
  showIdentityStage();
  tryFetchData();

  // Debug helpers
  window.__sponsorDebug = { sponsorData: sponsorData, stagedRatings: stagedRatings, completedProjects: completedProjects, reloadData: tryFetchData };
  window.__submitCurrentProject = submitCurrentProject;

  // ---------------------------
  // Single robust radio-toggle implementation
  // ---------------------------
  (function () {
    // Helper: walk composedPath to find a radio input (works with label clicks and for="id" labels)
    function findRadioFromEvent(e) {
      var path = (e.composedPath && e.composedPath()) || e.path;
      if (!path) {
        // fallback: build a path
        path = [];
        var node = e.target;
        while (node) { path.push(node); node = node.parentNode; }
      }
      for (var i = 0; i < path.length; i++) {
        var n = path[i];
        if (!n || !n.tagName) continue;
        var tag = n.tagName.toLowerCase();
        if (tag === 'input' && n.type === 'radio') return n;
        if (tag === 'label') {
          var q = n.querySelector && n.querySelector("input[type='radio']");
          if (q) return q;
          // label may reference input via for="" -> find by id
          var forId = n.getAttribute && n.getAttribute('for');
          if (forId) {
            var byId = document.getElementById(forId);
            if (byId && byId.type === 'radio') return byId;
          }
        }
      }
      return null;
    }

    // record checked state before browser toggles (pointerdown & touchstart)
    document.addEventListener('pointerdown', function (e) {
      try {
        var radio = findRadioFromEvent(e);
        if (!radio) return;
        radio.dataset.waschecked = radio.checked ? 'true' : 'false';
      } catch (err) { /* ignore */ }
    }, false);

    // for some older mobile browsers fallback to touchstart
    document.addEventListener('touchstart', function (e) {
      try {
        var radio = findRadioFromEvent(e);
        if (!radio) return;
        radio.dataset.waschecked = radio.checked ? 'true' : 'false';
      } catch (err) {}
    }, { passive: true });

    // keyboard activation: capture keydown so space/enter recorded before activation
    document.addEventListener('keydown', function (e) {
      if (e.key !== ' ' && e.key !== 'Spacebar' && e.key !== 'Enter') return;
      var active = document.activeElement;
      if (!active) return;
      if (active.tagName && active.tagName.toLowerCase() === 'input' && active.type === 'radio') {
        active.dataset.waschecked = active.checked ? 'true' : 'false';
      }
    }, false);

    // click: if it was checked before the interaction, uncheck it now and fire change
    document.addEventListener('click', function (e) {
      try {
        var radio = findRadioFromEvent(e);
        if (!radio) return;

        // If it was checked before pointerdown/keydown, toggle off now
        if (radio.dataset.waschecked === 'true') {
          // Use microtask so this runs after browser default toggling when necessary
          Promise.resolve().then(function () {
            if (radio.checked) {
              radio.checked = false;
              radio.dispatchEvent(new Event('change', { bubbles: true }));
            }
            radio.removeAttribute('data-waschecked');
          });
          return;
        }

        // Not previously checked: update marker to current checked state for potential later toggle
        radio.dataset.waschecked = radio.checked ? 'true' : 'false';
      } catch (err) {
        console.error('radio-toggle error', err);
      }
    }, false);
  })();

  // Expose a helper to attach toggles manually if needed (used in loadProjectIntoMatrix)
  // This helper attaches a toggle marker function to a single radio element (idempotent)
  window.__attachRadioToggle = function (radio) {
    try {
      if (!radio || radio.dataset.toggleAttached === '1') return;
      radio.dataset.toggleAttached = '1';
      // no-op: the global listeners handle toggle behavior; this exists in case you want to force a marker
    } catch (e) { /* ignore */ }
  };

})();







