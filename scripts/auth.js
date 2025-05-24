// Firebase config
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.11/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/9.6.11/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyDRjRUwS1AhTzOt6SHAl75lE9k3prHWHpA",
  authDomain: "th3-restaurant.firebaseapp.com",
  projectId: "th3-restaurant",
  storageBucket: "th3-restaurant.firebasestorage.app",
  messagingSenderId: "949086230815",
  appId: "1:949086230815:web:a32da4415cb70850c0b82a",
  measurementId: "G-F0LXFVHGGG"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// Register handler
document.getElementById("registerForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("email").value;
  const pass = document.getElementById("password").value;
  const confirm = document.getElementById("confirmPassword").value;

  if (pass !== confirm) {
    alert("Passwords do not match!");
    return;
  }

  try {
    const userCred = await createUserWithEmailAndPassword(auth, email, pass);
    alert("Registration Successful!");
    console.log(userCred);
  } catch (err) {
    alert("Error: " + err.message);
  }
});
