/// <reference types="vite/client" />
import { render } from "solid-js/web";
import { Admin } from "./Admin";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Polyptic admin: missing #root element");
}

render(() => <Admin />, root);
