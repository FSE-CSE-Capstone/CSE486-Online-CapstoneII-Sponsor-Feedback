(function () {
  'use strict';

  // -------------------------------------------------------
  // Semester-aware localStorage key
  // Instructors: change window.SURVEY_ROUND in index.html each semester.
  // -------------------------------------------------------
  var ROUND = (typeof window.SURVEY_ROUND !== 'undefined' && window.SURVEY_ROUND)
    ? String(window.SURVEY_ROUND)
    : 'default';
  var STORAGE_KEY = 'sponsor_progress_v1_' + ROUND;

  // Remove any stale keys from previous rounds automatically
  try {
    Object.keys(localStorage).forEach(function (k) {
      if (k.indexOf('sponsor_progress_v1_') === 0 && k !== STORAGE_KEY) {
        localStorage.removeItem(k);
      }
    });
  } catch (e) { console.warn('Round cleanup failed', e); }

  // --- Configuration (Cloudflare Workers endpoints) ---
  var ENDPOINT_URL = 'https://cse486-online-worker.sbecerr7.workers.dev/';
  var DATA_LOADER_URL = 'https://cse486-online-data-loader.sbecerr7.workers.dev/';

  // --- Rubric ---
  var RUBRIC = [
    { title: "Student has contributed an appropriate amount of development effort towards this project", description: "Development effort should be balanced between all team members; student should commit to a fair amount of development effort on each sprint." },
    { title: "Meetings", description: "Students are expected to be proactive. Contributions and participation in meetings help ensure the student is aware of project goals." },
    { title: "Understanding", description: "Students are expected to understand important details of the project and be able to explain it from different stakeholder perspectives." },
    { title: "Quality", description: "Students should complete assigned work to a high quality: correct, documented, and self-explanatory where appropriate." },
    { title: "Communication", description: "Students are expected to be in regular communication and maintain professionalism when interacting with the sponsor." }
  ];

  // --- DOM refs ---
  var $ = function (id) { return document.getElementById(id); };
  var stageIdentity     = $('stage-identity');
  var stageProjects     = $('stage-projects');
  var stageThankyou     = $('stage-thankyou');
  var identitySubmit    = $('identitySubmit');
  var backToIdentity    = $('backToIdentity');
  var nameInput         = $('fullName');
  var emailInput        = $('email');
  var projectListEl     = $('project-list');
  var matrixContainer   = $('matrix-container');
  var formStatus        = $('form-status');
  var submitProjectBtn  = $('submitProject');
  var finishStartOverBtn = $('finishStartOver');
  var downloadReportBtn = $('downloadReport');
  var printReportBtn    = $('printReport');
  var welcomeBlock      = $('welcome-block');
  var underTitle        = $('under-title');
  var progressCounter   = $('progress-counter');

  // --- State ---
  var sponsorData         = {};
  var sponsorProjects     = {};
  var currentEmail        = '';
  var currentName         = '';
  var currentProject      = '';
  var completedProjects   = {};   // map: email -> { projectName: true }
  var stagedRatings       = {};
  var submittedResponses  = {};   // map: projectName -> full payload

  // -------------------------------------------------------
  // Helper functions
  // -------------------------------------------------------

  // Status messages — uses type classes, not inline colors
  function setStatus(msg, type) {
    if (!formStatus) return;
    formStatus.textContent = msg || '';
    formStatus.className = 'form-status' + (type ? ' form-status-' + type : '');
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, function (m) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m];
    });
  }

  // Element builder utility
  function el(tag, props, children) {
    var n = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        if (k === 'class')  n.className = props[k];
        else if (k === 'html')  n.innerHTML = props[k];
        else if (k === 'text')  n.textContent = props[k];
        else if (k === 'style') Object.assign(n.style, props[k]);
        else n.setAttribute(k, props[k]);
      });
    }
    if (children) {
      children.forEach(function (c) {
        if (typeof c === 'string') n.appendChild(document.createTextNode(c));
        else n.appendChild(c);
      });
    }
    return n;
  }

  // -------------------------------------------------------
  // Build sponsor map from raw data rows
  // -------------------------------------------------------
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

  // -------------------------------------------------------
  // Persistence — includes submittedResponses
  // -------------------------------------------------------
  function saveProgress() {
    var payload = {
      name: currentName,
      email: currentEmail,
      completedProjects: completedProjects,
      stagedRatings: stagedRatings,
      submittedResponses: submittedResponses
    };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(payload)); } catch (e) { console.warn('Could not save progress', e); }
  }

  // Returns true if saved progress was found and restored, false otherwise
  function loadProgress() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      var obj = JSON.parse(raw);
      if (obj) {
        currentName         = obj.name               || '';
        currentEmail        = obj.email              || '';
        completedProjects   = obj.completedProjects  || {};
        stagedRatings       = obj.stagedRatings      || {};
        submittedResponses  = obj.submittedResponses || {};
        if (nameInput)  nameInput.value  = currentName;
        if (emailInput) emailInput.value = currentEmail;
        return !!(currentEmail);
      }
    } catch (e) { console.warn('Could not load progress', e); }
    return false;
  }

  // -------------------------------------------------------
  // Completion helpers
  // -------------------------------------------------------
  function isProjectCompletedForEmail(email, projectName) {
    if (!email || !projectName) return false;
    return !!(completedProjects[email] && completedProjects[email][projectName]);
  }

  function hasCompletedAllProjects() {
    var entry = sponsorData[currentEmail] || {};
    var all = Object.keys(entry.projects || {});
    if (!all.length) return false;
    for (var i = 0; i < all.length; i++) {
      if (!isProjectCompletedForEmail(currentEmail, all[i])) return false;
    }
    return true;
  }

  // -------------------------------------------------------
  // Progress counter
  // -------------------------------------------------------
  function updateProgressCounter() {
    if (!progressCounter || !currentEmail) return;
    var entry = sponsorData[currentEmail] || {};
    var total = Object.keys(entry.projects || {}).length;
    var done  = Object.keys((completedProjects[currentEmail] || {})).length;
    progressCounter.textContent = done + ' of ' + total + ' projects completed';
  }

  // -------------------------------------------------------
  // Populate project list
  // -------------------------------------------------------
  function populateProjectListFor(email) {
    if (!projectListEl) return;
    projectListEl.innerHTML = '';
    sponsorProjects = {};
    var entry = sponsorData[email];
    if (!entry || !entry.projects) { setStatus('No projects found for that email.', 'error'); return; }
    var allProjects = Object.keys(entry.projects).slice();
    // Sort: incomplete first, completed at bottom
    allProjects.sort(function (a, b) {
      var ca = isProjectCompletedForEmail(email, a) ? 1 : 0;
      var cb = isProjectCompletedForEmail(email, b) ? 1 : 0;
      return ca - cb;
    });
    allProjects.forEach(function (p) {
      var isDone = isProjectCompletedForEmail(email, p);
      var li = el('li', {
        class: 'project-item' + (isDone ? ' completed' : ''),
        tabindex: isDone ? '-1' : '0',
        'data-project': p
      });

      if (isDone) {
        li.innerHTML =
          '<span class="project-item-name"><strong>' + escapeHtml(p) + '</strong></span>' +
          ' <span class="meta">&#10003; (Completed)</span>';
      } else {
        li.innerHTML =
          '<span class="project-item-name"><strong>' + escapeHtml(p) + '</strong></span>' +
          '<span class="project-item-arrow">&#8250;</span>';

        // Click and keydown handlers only for incomplete items (closure captures p safely via forEach)
        li.addEventListener('click', function () {
          Array.from(projectListEl.querySelectorAll('.project-item.active')).forEach(function (a) { a.classList.remove('active'); });
          li.classList.add('active');
          currentProject = p;
          loadProjectIntoMatrix(p, entry.projects[p]);
          setStatus('');
        });
        li.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            Array.from(projectListEl.querySelectorAll('.project-item.active')).forEach(function (a) { a.classList.remove('active'); });
            li.classList.add('active');
            currentProject = p;
            loadProjectIntoMatrix(p, entry.projects[p]);
            setStatus('');
          }
        });
      }

      projectListEl.appendChild(li);
      sponsorProjects[p] = entry.projects[p].slice();
    });

    updateProgressCounter();
    setStatus('');
  }

  // -------------------------------------------------------
  // Validation before submit
  // -------------------------------------------------------
  function validateRatings(students) {
    var issues = [];
    for (var c = 0; c < RUBRIC.length; c++) {
      var teamSel = document.querySelector('input[name="rating-' + c + '-team"]:checked');
      if (teamSel) continue; // team rating covers this criterion
      var anyStudentRated = false;
      for (var s = 0; s < students.length; s++) {
        if (document.querySelector('input[name="rating-' + c + '-' + s + '"]:checked')) {
          anyStudentRated = true;
          break;
        }
      }
      if (!anyStudentRated) {
        issues.push('Please rate criterion ' + (c + 1) + ' ("' + RUBRIC[c].title + '") for at least one student or the team overall.');
      }
    }
    return issues;
  }

  // -------------------------------------------------------
  // Build rating matrix for a project
  // -------------------------------------------------------
  function loadProjectIntoMatrix(projectName, students) {
    if (!projectName) return;
    currentProject = projectName;

    // Remove any existing matrix-info and comment section before rebuilding
    var existingInfo = $('matrix-info');
    if (existingInfo && existingInfo.parentNode) existingInfo.parentNode.removeChild(existingInfo);
    Array.from(document.querySelectorAll('.current-project-header')).forEach(function (h) {
      if (h.parentNode) h.parentNode.removeChild(h);
    });
    var oldComment = document.querySelector('.section.section-comment');
    if (oldComment && oldComment.parentNode) oldComment.parentNode.removeChild(oldComment);

    // Build #matrix-info header and insert before #matrix-container
    var info = el('div', { id: 'matrix-info', class: 'matrix-info-block' });
    var hdr  = el('div', { class: 'current-project-header', text: projectName });
    var topDesc = el('div', { class: 'matrix-info-desc', text: 'Please evaluate the students using the rubric below (scale 1–7).' });
    info.appendChild(hdr);
    info.appendChild(topDesc);
    if (matrixContainer && matrixContainer.parentNode) {
      matrixContainer.parentNode.insertBefore(info, matrixContainer);
    } else if (matrixContainer) {
      document.body.insertBefore(info, matrixContainer);
    }

    if (!students || !students.length) {
      if (matrixContainer) matrixContainer.textContent = 'No students found for this project.';
      return;
    }

    if (!stagedRatings[currentProject]) stagedRatings[currentProject] = {};

    // Build matrix content in a temp container
    var temp = document.createElement('div');

    RUBRIC.forEach(function (crit, cIdx) {
      var card = el('div', { class: 'card matrix-card', style: { marginBottom: '20px', padding: '18px' } });
      var critWrap  = el('div', { class: 'matrix-criterion' });
      var critTitle = el('h4', { class: 'matrix-criterion-title', text: (cIdx + 1) + '. ' + crit.title });
      var critDesc  = el('div', { class: 'matrix-criterion-desc', text: crit.description });
      critWrap.appendChild(critTitle);
      critWrap.appendChild(critDesc);

      var tableWrap = el('div', { class: 'table-scroll-wrap' });
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
      trHead.appendChild(el('th', { class: 'header-descriptor', html: '<div class="hd-line">Far Below Expectations</div><div class="hd-sub">(Fail)</div>' }));
      for (var k = 1; k <= 7; k++) {
        trHead.appendChild(el('th', { class: 'col-score-num', text: String(k), style: { padding: '8px', textAlign: 'center' } }));
      }
      trHead.appendChild(el('th', { class: 'header-descriptor header-descriptor-right', html: '<div class="hd-line">Exceeds Expectations</div><div class="hd-sub">(A+)</div>' }));
      thead.appendChild(trHead);
      table.appendChild(thead);

      var tbody = el('tbody');

      // Student rows
      students.forEach(function (studentName, sIdx) {
        var rowClass = sIdx % 2 === 0 ? 'row-even' : 'row-odd';
        var tr = el('tr', { class: rowClass });
        tr.appendChild(el('td', { class: 'col-student', text: studentName }));
        tr.appendChild(el('td', { class: 'col-descriptor col-radio' }));

        for (var score = 1; score <= 7; score++) {
          var td    = el('td', { style: { textAlign: 'center', padding: '8px' } });
          var inp   = el('input', {
            type: 'radio',
            name: 'rating-' + cIdx + '-' + sIdx,
            value: String(score),
            id: 'rating-' + cIdx + '-' + sIdx + '-' + score,
            class: 'radio-label'
          });
          var staged = (stagedRatings[currentProject] && stagedRatings[currentProject][sIdx]) || {};
          if (staged[cIdx] && String(staged[cIdx]) === String(score)) inp.checked = true;
          var lbl = el('label', { 'for': inp.id, class: 'radio-label', style: { cursor: 'pointer', display: 'inline-block', padding: '2px' } });
          lbl.appendChild(inp);
          td.appendChild(lbl);
          tr.appendChild(td);
        }

        tr.appendChild(el('td', { class: 'col-descriptor col-radio' }));
        tbody.appendChild(tr);
      });

      // Team Overall row
      var trTeam = el('tr', { class: 'row-team' });
      trTeam.appendChild(el('td', { class: 'col-student', text: 'Team Overall' }));
      trTeam.appendChild(el('td', { class: 'col-descriptor col-radio' }));
      for (var sScore = 1; sScore <= 7; sScore++) {
        var tdT   = el('td', { style: { textAlign: 'center', padding: '8px' } });
        var inpT  = el('input', {
          type: 'radio',
          name: 'rating-' + cIdx + '-team',
          value: String(sScore),
          id: 'rating-' + cIdx + '-team-' + sScore,
          class: 'radio-label'
        });
        var stagedTeam = (stagedRatings[currentProject] && stagedRatings[currentProject].team) || {};
        if (stagedTeam[cIdx] && String(stagedTeam[cIdx]) === String(sScore)) inpT.checked = true;
        var lblT = el('label', { 'for': inpT.id, class: 'radio-label', style: { cursor: 'pointer', display: 'inline-block', padding: '2px' } });
        lblT.appendChild(inpT);
        tdT.appendChild(lblT);
        trTeam.appendChild(tdT);
      }
      trTeam.appendChild(el('td', { class: 'col-descriptor col-radio' }));
      tbody.appendChild(trTeam);

      table.appendChild(tbody);
      tableWrap.appendChild(table);
      critWrap.appendChild(tableWrap);
      card.appendChild(critWrap);
      temp.appendChild(card);
    });

    // Replace matrix content
    if (matrixContainer) {
      matrixContainer.innerHTML = '';
      while (temp.firstChild) matrixContainer.appendChild(temp.firstChild);
    }

    // Render comments (adds its own textarea listeners)
    renderCommentSection(projectName, students);

    // Attach radio change listeners to matrix container
    attachMatrixListeners();

    // Wire radio toggle helper if present
    if (typeof window.__attachRadioToggle === 'function') {
      Array.prototype.forEach.call(matrixContainer.querySelectorAll("input[type='radio']"), function (r) {
        window.__attachRadioToggle(r);
      });
    }

    // Auto-scroll to #matrix-info after DOM settles
    setTimeout(function () {
      var infoEl = $('matrix-info');
      if (infoEl) infoEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 120);
  }

  // -------------------------------------------------------
  // Render comment section — adds its own textarea listeners
  // -------------------------------------------------------
  function renderCommentSection(projectName, students) {
    var oldComment = document.querySelector('.section.section-comment');
    if (oldComment && oldComment.parentNode) oldComment.parentNode.removeChild(oldComment);

    var commentSec = el('div', { class: 'section section-comment', style: { marginTop: '12px', display: 'block' } });
    commentSec.appendChild(el('h3', { class: 'comment-panel-header', text: 'Add your additional comments', style: { margin: '0 0 12px 0', fontSize: '1rem', fontWeight: '700' } }));

    var staged = (stagedRatings[projectName] && stagedRatings[projectName]._studentComments) || {};

    students.forEach(function (studentName, sIdx) {
      var wrapper = el('div', { class: 'student-comment-panel', style: { border: '1px solid rgba(10,12,30,0.05)', borderRadius: '8px', padding: '10px', marginBottom: '10px', background: '#fff' } });
      var headerRow = el('div', { class: 'comment-panel-name', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' } });
      headerRow.appendChild(el('div', { text: studentName, style: { fontWeight: '600' } }));

      var toggleBtn = el('button', { type: 'button', class: 'btn btn-mini comment-toggle', text: '\u25be Add comment' });
      headerRow.appendChild(toggleBtn);
      wrapper.appendChild(headerRow);

      var content = el('div', { class: 'student-comment-content', style: { display: 'none' } });
      content.appendChild(el('div', { class: 'comment-label', text: 'Comments to be SHARED WITH THE STUDENT', style: { fontSize: '0.9rem', margin: '4px 0' } }));
      var taPublic = el('textarea', { id: 'comment-public-' + sIdx, placeholder: 'Comments to share with student', style: { width: '100%', minHeight: '60px', padding: '8px', boxSizing: 'border-box', marginBottom: '8px' } });
      content.appendChild(taPublic);

      content.appendChild(el('div', { class: 'comment-label', text: 'Comments to be SHARED ONLY WITH THE INSTRUCTOR', style: { fontSize: '0.9rem', margin: '4px 0' } }));
      var taPrivate = el('textarea', { id: 'comment-private-' + sIdx, placeholder: 'Private comments for instructor', style: { width: '100%', minHeight: '60px', padding: '8px', boxSizing: 'border-box' } });
      content.appendChild(taPrivate);

      // Auto-save on input — added here so textareas are always wired regardless of render order
      taPublic.addEventListener('input', saveDraftHandler);
      taPrivate.addEventListener('input', saveDraftHandler);

      toggleBtn.addEventListener('click', function () {
        if (content.style.display === 'none') {
          content.style.display = 'block';
          toggleBtn.textContent = '\u25b4 Hide comment';
        } else {
          content.style.display = 'none';
          toggleBtn.textContent = '\u25be Add comment';
        }
      });

      var st = staged && staged[studentName];
      if (st) {
        if (st.public)  taPublic.value  = st.public;
        if (st.private) taPrivate.value = st.private;
        if ((st.public && st.public.length) || (st.private && st.private.length)) {
          content.style.display = 'block';
          toggleBtn.textContent = '\u25b4 Hide comment';
        }
      }

      wrapper.appendChild(content);
      commentSec.appendChild(wrapper);
    });

    // Group panel
    var groupWrap = el('div', { class: 'student-comment-panel', style: { border: '1px solid rgba(10,12,30,0.05)', borderRadius: '8px', padding: '10px', marginBottom: '10px', background: '#fff' } });
    var groupHeader = el('div', { class: 'comment-panel-name', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' } });
    groupHeader.appendChild(el('div', { text: 'Comments for team overall', style: { fontWeight: '600' } }));
    var groupToggle = el('button', { type: 'button', class: 'btn btn-mini comment-toggle', text: '\u25be Add comment' });
    groupHeader.appendChild(groupToggle);
    groupWrap.appendChild(groupHeader);

    var groupContent = el('div', { style: { display: 'none' } });
    groupContent.appendChild(el('div', { class: 'comment-label', text: 'Comments for team overall (shared with student by default)', style: { margin: '4px 0' } }));
    var taGroup = el('textarea', { id: 'comment-group-public', placeholder: 'Comments for team overall', style: { width: '100%', minHeight: '80px', padding: '8px', boxSizing: 'border-box' } });
    groupContent.appendChild(taGroup);
    groupContent.appendChild(el('div', { class: 'comment-label', text: 'Private comments about the team (instructor only)', style: { margin: '8px 0 4px 0' } }));
    var taGroupPrivate = el('textarea', { id: 'comment-group-private', placeholder: 'Private comments for instructor about the team', style: { width: '100%', minHeight: '60px', padding: '8px', boxSizing: 'border-box' } });
    groupContent.appendChild(taGroupPrivate);

    // Auto-save on input
    taGroup.addEventListener('input', saveDraftHandler);
    taGroupPrivate.addEventListener('input', saveDraftHandler);

    groupToggle.addEventListener('click', function () {
      if (groupContent.style.display === 'none') {
        groupContent.style.display = 'block';
        groupToggle.textContent = '\u25b4 Hide comment';
      } else {
        groupContent.style.display = 'none';
        groupToggle.textContent = '\u25be Add comment';
      }
    });

    var stagedGroup = (stagedRatings[currentProject] && stagedRatings[currentProject]._groupComments) || {};
    if (stagedGroup.public)  taGroup.value        = stagedGroup.public;
    if (stagedGroup.private) taGroupPrivate.value = stagedGroup.private;
    if ((stagedGroup.public && stagedGroup.public.length) || (stagedGroup.private && stagedGroup.private.length)) {
      groupContent.style.display = 'block';
      groupToggle.textContent = '\u25b4 Hide comment';
    }

    groupWrap.appendChild(groupContent);
    commentSec.appendChild(groupWrap);

    // Insert comment section after #matrix-container
    if (matrixContainer && matrixContainer.parentNode) {
      if (matrixContainer.nextSibling) {
        matrixContainer.parentNode.insertBefore(commentSec, matrixContainer.nextSibling);
      } else {
        matrixContainer.parentNode.appendChild(commentSec);
      }
    } else {
      document.body.appendChild(commentSec);
    }
  }

  // -------------------------------------------------------
  // Attach matrix container listeners (radio change / input)
  // -------------------------------------------------------
  function attachMatrixListeners() {
    if (!matrixContainer) return;
    // Remove before re-adding to avoid duplicate bindings (works because saveDraftHandler is a stable named ref)
    matrixContainer.removeEventListener('change', saveDraftHandler);
    matrixContainer.removeEventListener('input',  saveDraftHandler);
    matrixContainer.addEventListener('change', saveDraftHandler);
    matrixContainer.addEventListener('input',  saveDraftHandler);
  }

  // -------------------------------------------------------
  // Save draft: collect ratings + comments from DOM
  // -------------------------------------------------------
  function saveDraftHandler() {
    if (!currentProject) return;
    if (!stagedRatings[currentProject]) stagedRatings[currentProject] = {};
    var students = sponsorProjects[currentProject] || [];

    // Student ratings
    for (var s = 0; s < students.length; s++) {
      stagedRatings[currentProject][s] = stagedRatings[currentProject][s] || {};
      for (var c = 0; c < RUBRIC.length; c++) {
        var sel = document.querySelector('input[name="rating-' + c + '-' + s + '"]:checked');
        if (sel) {
          stagedRatings[currentProject][s][c] = parseInt(sel.value, 10);
        } else if (stagedRatings[currentProject][s][c] === undefined) {
          stagedRatings[currentProject][s][c] = null;
        }
      }
    }

    // Team ratings
    stagedRatings[currentProject].team = stagedRatings[currentProject].team || {};
    for (var ct = 0; ct < RUBRIC.length; ct++) {
      var selT = document.querySelector('input[name="rating-' + ct + '-team"]:checked');
      if (selT) {
        stagedRatings[currentProject].team[ct] = parseInt(selT.value, 10);
      } else if (stagedRatings[currentProject].team[ct] === undefined) {
        stagedRatings[currentProject].team[ct] = null;
      }
    }

    // Student comments
    stagedRatings[currentProject]._studentComments = stagedRatings[currentProject]._studentComments || {};
    for (var i = 0; i < students.length; i++) {
      var sName   = students[i];
      var pubEl   = document.getElementById('comment-public-' + i);
      var privEl  = document.getElementById('comment-private-' + i);
      stagedRatings[currentProject]._studentComments[sName] = stagedRatings[currentProject]._studentComments[sName] || { public: '', private: '' };
      if (pubEl)  stagedRatings[currentProject]._studentComments[sName].public  = pubEl.value  || '';
      if (privEl) stagedRatings[currentProject]._studentComments[sName].private = privEl.value || '';
    }

    // Group comments
    stagedRatings[currentProject]._groupComments = stagedRatings[currentProject]._groupComments || { public: '', private: '' };
    var gpPub  = document.getElementById('comment-group-public');
    var gpPriv = document.getElementById('comment-group-private');
    if (gpPub)  stagedRatings[currentProject]._groupComments.public  = gpPub.value  || '';
    if (gpPriv) stagedRatings[currentProject]._groupComments.private = gpPriv.value || '';

    saveProgress();
  }

  // -------------------------------------------------------
  // Build payload and submit current project
  // -------------------------------------------------------
  function submitCurrentProject() {
    if (!currentProject) { setStatus('No project is loaded.', 'error'); return; }
    var students = sponsorProjects[currentProject] || [];
    if (!students.length) { setStatus('No students to submit.', 'error'); return; }

    // Validate ratings before building payload
    var issues = validateRatings(students);
    if (issues.length) { setStatus(issues[0], 'error'); return; }

    var responses = [];
    for (var s = 0; s < students.length; s++) {
      var ratingsObj = {};
      for (var c = 0; c < RUBRIC.length; c++) {
        var sel = document.querySelector('input[name="rating-' + c + '-' + s + '"]:checked');
        ratingsObj[RUBRIC[c].title || ('C' + c)] = sel ? parseInt(sel.value, 10) : null;
      }
      var commentShared     = (document.getElementById('comment-public-' + s) || {}).value  || '';
      var commentInstructor = (document.getElementById('comment-private-' + s) || {}).value || '';
      responses.push({ student: students[s], ratings: ratingsObj, commentShared: commentShared, commentInstructor: commentInstructor, isTeam: false });
    }

    // Team row
    var teamRatingsChosen = false;
    var teamRatingsObj = {};
    for (var tc = 0; tc < RUBRIC.length; tc++) {
      var teamSel = document.querySelector('input[name="rating-' + tc + '-team"]:checked');
      teamRatingsObj[RUBRIC[tc].title || ('C' + tc)] = teamSel ? parseInt(teamSel.value, 10) : null;
      if (teamSel) teamRatingsChosen = true;
    }
    var groupCommentShared     = (document.getElementById('comment-group-public')  || {}).value || '';
    var groupCommentInstructor = (document.getElementById('comment-group-private') || {}).value || '';
    if (teamRatingsChosen || groupCommentShared || groupCommentInstructor) {
      responses.push({ student: 'Evaluating group as a whole', ratings: teamRatingsObj, commentShared: groupCommentShared, commentInstructor: groupCommentInstructor, isTeam: true });
    }

    if (!responses.length) { setStatus('Nothing to submit.', 'error'); return; }

    var payload = {
      sponsorName:  currentName  || (nameInput  ? nameInput.value.trim()  : ''),
      sponsorEmail: currentEmail || (emailInput ? emailInput.value.trim() : ''),
      project:      currentProject,
      rubric:       RUBRIC.map(function (r) { return r.title; }),
      responses:    responses,
      timestamp:    new Date().toISOString()
    };

    // Store response BEFORE the fetch so it's available even if the network is slow
    submittedResponses[currentProject] = payload;
    saveProgress();

    setStatus('Submitting\u2026', 'info');
    submitProjectBtn.disabled = true;

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
      setStatus('Submission saved. Thank you!', 'success');

      // Mark project completed under current sponsor email
      if (!currentEmail) currentEmail = (emailInput ? (emailInput.value || '').toLowerCase().trim() : '');
      completedProjects[currentEmail] = completedProjects[currentEmail] || {};
      completedProjects[currentEmail][currentProject] = true;

      if (stagedRatings[currentProject]) delete stagedRatings[currentProject];
      saveProgress();

      // Update the list item — replace node to cleanly strip event listeners
      if (projectListEl) {
        var safeProject = currentProject;
        var escFn = (window.CSS && CSS.escape) ? CSS.escape : function (s) { return s.replace(/["\\]/g, '\\$&'); };
        var selector = 'li[data-project="' + escFn(safeProject) + '"]';
        var li = projectListEl.querySelector(selector);
        if (li) {
          li.classList.add('completed');
          li.classList.remove('active');
          li.setAttribute('tabindex', '-1');
          li.innerHTML =
            '<span class="project-item-name"><strong>' + escapeHtml(safeProject) + '</strong></span>' +
            ' <span class="meta">&#10003; (Completed)</span>';
          // Clone to remove all event listeners
          var newLi = li.cloneNode(true);
          li.parentNode.replaceChild(newLi, li);
        }
      }

      updateProgressCounter();

      // Clear matrix UI
      if (matrixContainer) matrixContainer.innerHTML = '';
      var commentSection = document.querySelector('.section.section-comment');
      if (commentSection && commentSection.parentNode) commentSection.parentNode.removeChild(commentSection);
      var matrixInfoBlock = $('matrix-info');
      if (matrixInfoBlock && matrixInfoBlock.parentNode) matrixInfoBlock.parentNode.removeChild(matrixInfoBlock);

      currentProject = '';

      if (hasCompletedAllProjects()) showThankyouStage();
    }).catch(function (err) {
      console.error('Submission failed', err);
      setStatus('Submission failed. Please check your connection and try again.', 'error');
    }).finally(function () {
      if (submitProjectBtn) submitProjectBtn.disabled = false;
    });
  }

  // -------------------------------------------------------
  // Identity form submit
  // -------------------------------------------------------
  function onIdentitySubmit() {
    var name  = nameInput  ? nameInput.value.trim()                        : '';
    var email = emailInput ? (emailInput.value || '').toLowerCase().trim() : '';
    if (!name)  { setStatus('Please enter your name.',          'error'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setStatus('Please enter a valid email address.', 'error'); return; }

    currentName  = name;
    currentEmail = email;
    saveProgress();

    if (!sponsorData || Object.keys(sponsorData).length === 0) {
      setStatus('Loading project data, please wait\u2026', 'info');
      tryFetchData(function () {
        if (!sponsorData || !sponsorData[currentEmail]) { setStatus('No projects found for that email.', 'error'); return; }
        showProjectsStage();
        populateProjectListFor(currentEmail);
      });
    } else {
      if (!sponsorData[currentEmail]) { setStatus('No projects found for that email.', 'error'); return; }
      showProjectsStage();
      populateProjectListFor(currentEmail);
    }
  }

  // -------------------------------------------------------
  // Report generation
  // -------------------------------------------------------
  function generateReportHTML() {
    var now       = new Date().toLocaleString();
    var rubricTitles = RUBRIC.map(function (r) { return r.title; });
    var parts = [];

    parts.push('<!doctype html><html lang="en"><head><meta charset="utf-8">');
    parts.push('<title>Sponsor Evaluation Report \u2014 ' + escapeHtml(currentName) + '</title>');
    parts.push('<style>');
    parts.push('body{font-family:Arial,Helvetica,sans-serif;margin:24px;color:#222;font-size:14px}');
    parts.push('h1{color:#8c1d40;margin-bottom:4px}');
    parts.push('h2{color:#333;border-bottom:2px solid #ddd;padding-bottom:6px;margin-top:32px}');
    parts.push('p{margin:4px 0}');
    parts.push('table{border-collapse:collapse;width:100%;margin:12px 0 20px;font-size:13px}');
    parts.push('th,td{border:1px solid #ccc;padding:7px 10px;text-align:left;vertical-align:top}');
    parts.push('th{background:#f0f0f0;font-weight:bold;white-space:nowrap}');
    parts.push('td.score{text-align:center;font-weight:bold}');
    parts.push('.comment-block{margin:3px 0;font-size:12px;color:#444}');
    parts.push('.print-controls{margin-bottom:20px}');
    parts.push('.print-controls button{margin-right:8px;padding:8px 16px;cursor:pointer;border:1px solid #999;border-radius:4px;background:#f5f5f5;font-size:14px}');
    parts.push('.no-data{color:#888;font-style:italic}');
    parts.push('@media print{.print-controls{display:none}}');
    parts.push('</style></head><body>');

    parts.push('<div class="print-controls">');
    parts.push('<button onclick="window.print()">Print</button>');
    parts.push('<button onclick="window.close()">Close</button>');
    parts.push('</div>');

    parts.push('<h1>Sponsor Evaluation Report</h1>');
    parts.push('<p><strong>Sponsor Name:</strong> ' + escapeHtml(currentName) + '</p>');
    parts.push('<p><strong>Sponsor Email:</strong> ' + escapeHtml(currentEmail) + '</p>');
    parts.push('<p><strong>Survey Round:</strong> ' + escapeHtml(ROUND) + '</p>');
    parts.push('<p><strong>Generated:</strong> ' + escapeHtml(now) + '</p>');

    var projects = Object.keys(submittedResponses);
    if (!projects.length) {
      parts.push('<p class="no-data">No submitted evaluations found.</p>');
    } else {
      projects.forEach(function (projName) {
        var data = submittedResponses[projName];
        if (!data) return;
        var cols = data.rubric || rubricTitles;

        parts.push('<h2>Project: ' + escapeHtml(projName) + '</h2>');
        parts.push('<p><em>Submitted: ' + escapeHtml(data.timestamp || '') + '</em></p>');

        // Ratings table
        parts.push('<table>');
        parts.push('<thead><tr><th>Student</th>');
        cols.forEach(function (col) { parts.push('<th>' + escapeHtml(col) + '</th>'); });
        parts.push('</tr></thead><tbody>');

        (data.responses || []).forEach(function (resp) {
          parts.push('<tr>');
          parts.push('<td>' + escapeHtml(resp.student || '') + (resp.isTeam ? ' <em>(Team)</em>' : '') + '</td>');
          cols.forEach(function (col) {
            var score = (resp.ratings && resp.ratings[col] != null) ? resp.ratings[col] : '\u2014';
            parts.push('<td class="score">' + escapeHtml(String(score)) + '</td>');
          });
          parts.push('</tr>');

          // Inline comment rows
          if (resp.commentShared || resp.commentInstructor) {
            parts.push('<tr><td colspan="' + (cols.length + 1) + '" style="background:#fafafa">');
            if (resp.commentShared)     parts.push('<div class="comment-block"><strong>Shared with student:</strong> ' + escapeHtml(resp.commentShared) + '</div>');
            if (resp.commentInstructor) parts.push('<div class="comment-block"><strong>Private (instructor only):</strong> ' + escapeHtml(resp.commentInstructor) + '</div>');
            parts.push('</td></tr>');
          }
        });

        parts.push('</tbody></table>');
      });
    }

    parts.push('</body></html>');
    return parts.join('');
  }

  function downloadReport() {
    var html = generateReportHTML();
    var blob = new Blob([html], { type: 'text/html' });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement('a');
    a.href     = url;
    a.download = 'sponsor-report-' + (currentName || 'sponsor').replace(/\s+/g, '-') + '-' + ROUND + '.html';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  function printReport() {
    var html = generateReportHTML();
    var win  = window.open('', '_blank');
    if (!win) { alert('Please allow popups for this page to use Print Report.'); return; }
    win.document.write(html);
    win.document.close();
    setTimeout(function () { win.print(); }, 600);
  }

  // -------------------------------------------------------
  // Event wiring — each handler wired exactly once
  // -------------------------------------------------------
  if (identitySubmit)    identitySubmit.addEventListener('click', onIdentitySubmit);
  if (backToIdentity)    backToIdentity.addEventListener('click', showIdentityStage);
  if (submitProjectBtn)  submitProjectBtn.addEventListener('click', submitCurrentProject);
  if (downloadReportBtn) downloadReportBtn.addEventListener('click', downloadReport);
  if (printReportBtn)    printReportBtn.addEventListener('click', printReport);

  if (finishStartOverBtn) finishStartOverBtn.addEventListener('click', function () {
    completedProjects  = {};
    stagedRatings      = {};
    submittedResponses = {};
    saveProgress();
    currentProject = '';
    if (matrixContainer) matrixContainer.innerHTML = '';
    var commentSection = document.querySelector('.section.section-comment');
    if (commentSection && commentSection.parentNode) commentSection.parentNode.removeChild(commentSection);
    var matrixInfoEl = $('matrix-info');
    if (matrixInfoEl && matrixInfoEl.parentNode) matrixInfoEl.parentNode.removeChild(matrixInfoEl);
    showIdentityStage();
  });

  // Enter key on identity form fields
  function handleIdentityEnter(e) {
    if (e.key === 'Enter') onIdentitySubmit();
  }
  if (nameInput)  nameInput.addEventListener('keydown',  handleIdentityEnter);
  if (emailInput) emailInput.addEventListener('keydown', handleIdentityEnter);

  // Unsaved-changes warning
  window.addEventListener('beforeunload', function (e) {
    if (currentProject && stagedRatings[currentProject] && Object.keys(stagedRatings[currentProject]).length > 0) {
      e.returnValue = 'You have unsaved ratings for the current project. Are you sure you want to leave?';
    }
  });

  // -------------------------------------------------------
  // Stage display helpers — every helper toggles ALL elements
  // -------------------------------------------------------
  function showIdentityStage() {
    if (stageIdentity)  stageIdentity.style.display  = '';
    if (stageProjects)  stageProjects.style.display  = 'none';
    if (stageThankyou)  stageThankyou.style.display  = 'none';
    if (welcomeBlock)   welcomeBlock.style.display   = '';
    if (underTitle)     underTitle.style.display     = '';
    setStatus('');
  }
  function showProjectsStage() {
    if (stageIdentity)  stageIdentity.style.display  = 'none';
    if (stageProjects)  stageProjects.style.display  = '';
    if (stageThankyou)  stageThankyou.style.display  = 'none';
    if (welcomeBlock)   welcomeBlock.style.display   = 'none';
    if (underTitle)     underTitle.style.display     = 'none';
  }
  function showThankyouStage() {
    if (stageIdentity)  stageIdentity.style.display  = 'none';
    if (stageProjects)  stageProjects.style.display  = 'none';
    if (stageThankyou)  stageThankyou.style.display  = '';
    if (welcomeBlock)   welcomeBlock.style.display   = 'none';
    if (underTitle)     underTitle.style.display     = 'none';
  }

  // -------------------------------------------------------
  // Fetch sponsor data — does NOT call loadProgress internally
  // -------------------------------------------------------
  function tryFetchData(callback) {
    console.info('tryFetchData: requesting', DATA_LOADER_URL);
    fetch(DATA_LOADER_URL, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('Data loader returned ' + r.status);
        return r.json();
      })
      .then(function (rows) {
        sponsorData = buildSponsorMap(rows || []);
        if (typeof callback === 'function') callback();
      })
      .catch(function (err) {
        console.error('Data fetch failed', err);
        setStatus('Project data could not be loaded. Please try again later.', 'error');
        if (typeof callback === 'function') callback();
      });
  }

  // -------------------------------------------------------
  // UI cleanup on DOM ready
  // -------------------------------------------------------
  document.addEventListener('DOMContentLoaded', function () {
    var autoFooter = document.querySelector('.site-footer-fixed');
    if (autoFooter) autoFooter.parentNode.removeChild(autoFooter);
  });

  // -------------------------------------------------------
  // Boot sequence
  // 1. Restore any saved progress (returns true if found)
  // 2. Show identity stage
  // 3. Fetch data; show welcome-back message if progress was restored
  // -------------------------------------------------------
  var hadProgress = loadProgress();
  showIdentityStage();
  tryFetchData(function () {
    if (hadProgress && currentEmail && sponsorData[currentEmail]) {
      setStatus('Welcome back! Your previous progress has been restored. Click Continue to resume.', 'success');
    }
  });

  // -------------------------------------------------------
  // Debug helpers (getters keep values live)
  // -------------------------------------------------------
  window.__sponsorDebug = {
    get sponsorData()        { return sponsorData; },
    get stagedRatings()      { return stagedRatings; },
    get completedProjects()  { return completedProjects; },
    get submittedResponses() { return submittedResponses; },
    get storageKey()         { return STORAGE_KEY; },
    reloadData:    tryFetchData,
    generateReport: generateReportHTML
  };
  window.__submitCurrentProject = submitCurrentProject;

  // -------------------------------------------------------
  // Single robust radio-toggle implementation (click to deselect)
  // -------------------------------------------------------
  (function () {
    function findRadioFromEvent(e) {
      var path = (e.composedPath && e.composedPath()) || e.path;
      if (!path) {
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
          var forId = n.getAttribute && n.getAttribute('for');
          if (forId) {
            var byId = document.getElementById(forId);
            if (byId && byId.type === 'radio') return byId;
          }
        }
      }
      return null;
    }

    document.addEventListener('pointerdown', function (e) {
      try {
        var radio = findRadioFromEvent(e);
        if (!radio) return;
        radio.dataset.waschecked = radio.checked ? 'true' : 'false';
      } catch (err) { /* ignore */ }
    }, false);

    document.addEventListener('touchstart', function (e) {
      try {
        var radio = findRadioFromEvent(e);
        if (!radio) return;
        radio.dataset.waschecked = radio.checked ? 'true' : 'false';
      } catch (err) {}
    }, { passive: true });

    document.addEventListener('keydown', function (e) {
      if (e.key !== ' ' && e.key !== 'Spacebar' && e.key !== 'Enter') return;
      var active = document.activeElement;
      if (!active) return;
      if (active.tagName && active.tagName.toLowerCase() === 'input' && active.type === 'radio') {
        active.dataset.waschecked = active.checked ? 'true' : 'false';
      }
    }, false);

    document.addEventListener('click', function (e) {
      try {
        var radio = findRadioFromEvent(e);
        if (!radio) return;
        if (radio.dataset.waschecked === 'true') {
          Promise.resolve().then(function () {
            if (radio.checked) {
              radio.checked = false;
              radio.dispatchEvent(new Event('change', { bubbles: true }));
            }
            radio.removeAttribute('data-waschecked');
          });
          return;
        }
        radio.dataset.waschecked = radio.checked ? 'true' : 'false';
      } catch (err) {
        console.error('radio-toggle error', err);
      }
    }, false);
  })();

  // Expose helper to attach toggle markers manually if needed
  window.__attachRadioToggle = function (radio) {
    try {
      if (!radio || radio.dataset.toggleAttached === '1') return;
      radio.dataset.toggleAttached = '1';
      // global listeners handle toggle behavior; marker is a no-op
    } catch (e) { /* ignore */ }
  };

})();
