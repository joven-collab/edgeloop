// Adds an "EdgeLoop" button to the Stash top bar. Stash re-renders the bar
// often, so the button is re-added whenever it goes missing.
(function () {
    const URL = 'http://localhost:8420/';
    const ID = 'edgeloop-link';

    function add() {
        if (document.getElementById(ID)) return;
        const bar = document.querySelector('.navbar-buttons');
        if (!bar) return;
        const a = document.createElement('a');
        a.id = ID;
        a.href = URL;
        a.target = '_blank';
        a.rel = 'noopener';
        a.className = 'btn btn-secondary edgeloop-link';
        a.title = 'Open the Loop hub';
        a.textContent = 'Loop';
        bar.prepend(a);
    }

    new MutationObserver(add).observe(document.body, { childList: true, subtree: true });
    add();
})();
