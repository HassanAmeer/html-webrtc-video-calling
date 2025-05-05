// // Add click handlers for video switching
// document.querySelector('.local-video').addEventListener('click', function() {
//     this.classList.toggle('active');
//     document.querySelector('.remote-video').classList.toggle('active');
// });

// document.querySelector('.remote-video').addEventListener('click', function() {
//     this.classList.toggle('active');
//     document.querySelector('.local-video').classList.toggle('active');
// });

// // Bottom sheet functionality
// const callerListWrapper = document.querySelector('.caller-list-wrapper');
// const callerListHeading = document.querySelector('.caller-list-heading');

// callerListHeading.addEventListener('click', function() {
//     callerListWrapper.classList.toggle('expanded');
// });

// // Update the user list item creation
// function createUserListItem(username, isCurrentUser = false) {
//     const li = document.createElement('li');
//     const span = document.createElement('span');
//     span.textContent = isCurrentUser ? `${username} (You)` : username;
    
//     const callBtn = document.createElement('button');
//     callBtn.className = 'call-btn';
//     callBtn.innerHTML = '<img width="20" src="/images/phone.png" alt="Call">';
    
//     if (!isCurrentUser) {
//         callBtn.addEventListener('click', () => {
//             // Handle call initiation
//             startCall(username);
//         });
//     }
    
//     li.appendChild(span);
//     li.appendChild(callBtn);
//     return li;
// } 