import React from 'react';
import { ProductList } from './ProductList';
import { Cart } from './Cart';

export const App: React.FC = () => {
  return (
    <div className="app-container">
      <header className="app-header">
        <h1>E-Commerce Store</h1>
      </header>
      <main>
        <ProductList />
        <Cart />
      </main>
    </div>
  );
};